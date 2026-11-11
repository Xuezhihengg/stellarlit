/**
 * 站内 Agent 的规划层。
 *
 * 这里不让模型自由发挥:它只能从 5 个工具里选,最多 3 步,参数回到服务端
 * 还要再过一遍 schema。规划产物是**建议**,不是命令 —— 论文 id 必须能在当前
 * 星空里找到,找不到的那一步直接丢弃。
 *
 * 为什么先规划再执行,而不是让模型边想边调:
 * 供应商的 function calling 支持参差不齐,而 JSON 模式是通用能力。
 * 把「选工具」收敛成一次结构化输出,失败时可以整体退回默认检索,
 * 不会出现半个工具调用挂在半空的状态。
 */

import { z } from "zod";

import type { StarfieldPayload } from "@/types/api";
import type { PaperNode } from "@/types/kg";
import type { AskStep } from "@/types/rag";

import { chatJson } from "../llm/client";
import type { RetrievedSource } from "../rag/retrieve";
import { findMentionedPapers } from "../rag/query";
import type { EvidenceAssessment } from "./assess";

export const AGENT_TOOL_NAMES = [
  "search_starfield",
  "find_relation_evidence",
  "get_paper_context",
  "expand_citations",
  "search_papers",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const AGENT_TOOL_LABELS: Record<AgentToolName, string> = {
  search_starfield: "检索原文",
  find_relation_evidence: "查证关系",
  get_paper_context: "读论文上下文",
  expand_citations: "展开引文",
  search_papers: "外部检索",
};

export interface PlannedStep {
  tool: AgentToolName;
  args: Record<string, unknown>;
  why?: string;
}

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        tool: z.string(),
        args: z.record(z.unknown()).optional(),
        why: z.string().optional(),
      }),
    )
    .max(6),
});

const searchArgs = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(8).optional(),
});

const relationArgs = z.object({
  paperA: z.string().min(2).max(300),
  paperB: z.string().min(2).max(300),
});

const contextArgs = z.object({
  paperId: z.string().min(2).max(300),
});

const expandArgs = z.object({
  paperId: z.string().min(2).max(300),
  direction: z.enum(["backward", "forward", "both"]).optional(),
  limit: z.coerce.number().int().min(1).max(12).optional(),
});

const papersArgs = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

const TOOL_MANUAL = `- search_starfield {"query":"检索词","limit":1-8} —— 在星空语料里按词面找原文块。大多数问题的第一步都用它。
- find_relation_evidence {"paperA":"paper:...","paperB":"paper:..."} —— 查两篇**已判定**关系的类型、置信度与原文证据。
- get_paper_context {"paperId":"paper:..."} —— 读一篇论文的摘要,以及它在星空里的全部关系边。
- expand_citations {"paperId":"paper:...","direction":"backward|forward|both","limit":1-12} —— 去 OpenAlex 查参考文献或引用它的工作(外部结果)。
- search_papers {"query":"英文主题词","limit":1-10} —— 去 OpenAlex 按主题找外部文献(外部结果)。`;

const PLANNER_SYSTEM = `你是 StellarLit 的检索规划器。你不回答问题,只决定「为了回答这个问题,需要调用哪些星空工具」。

可用工具(只能从这里选):
${TOOL_MANUAL}

规则:
1. 最多 3 步,按执行顺序排列;只选真正能补证据的,不要凑数。
2. 问「某几篇之间是什么关系/区别/谁是谁的基线」时,先 find_relation_evidence,再按需要 search_starfield 补原文。
3. 问「这个方向还有哪些工作/后来谁沿用了它」时用 expand_citations;星空里没有的主题才用 search_papers。
4. paperA、paperB、paperId 只能取清单里出现过的 id,绝不编造;不确定就改用 search_starfield。
5. 问题很简单(定义、年份、被引量)时,一步 search_starfield 就够。
6. 不需要任何工具时返回 {"steps":[]}。

只输出 JSON,不要解释:{"steps":[{"tool":"search_starfield","args":{"query":"..."},"why":"一句话理由"}]}`;

export function paperCatalog(payload: StarfieldPayload): PaperNode[] {
  return payload.graph.nodes
    .filter((node): node is PaperNode => node.kind === "paper")
    .sort((a, b) => b.citations - a.citations)
    .slice(0, 30);
}

function buildUserPrompt(payload: StarfieldPayload, question: string): string {
  const papers = paperCatalog(payload);
  const lines = papers.map(
    (paper) => `${paper.id} 《${paper.title}》 ${paper.year || "年份未知"} 被引${paper.citations}`,
  );
  const kinds = [...new Set(payload.graph.edges.filter((e) => e.layer === "semantic").map((e) => e.kind))];
  return `<星空>
${payload.starfield.name} · ${payload.starfield.stats.papers} 篇 / ${payload.starfield.stats.edges} 条边
已判定关系类型:${kinds.join("、") || "无"}
</星空>

<论文清单>
${lines.join("\n")}
</论文清单>

问题:${question}`;
}

function resolvePaperId(papers: PaperNode[], raw: string): string | null {
  const value = raw.trim();
  const ids = new Set(papers.map((paper) => paper.id));
  if (ids.has(value)) return value;
  const prefixed = value.startsWith("paper:") ? value : `paper:${value}`;
  if (ids.has(prefixed)) return prefixed;

  const lower = value.toLowerCase();
  const exact = papers.find((paper) => paper.title.toLowerCase() === lower);
  if (exact) return exact.id;
  if (lower.length < 8) return null;
  const partial = papers.filter((paper) => paper.title.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]!.id : null;
}

function validateStep(papers: PaperNode[], step: { tool: string; args?: unknown }): PlannedStep | null {
  const tool = step.tool as AgentToolName;
  if (!AGENT_TOOL_NAMES.includes(tool)) return null;
  const raw = step.args ?? {};

  switch (tool) {
    case "search_starfield": {
      const parsed = searchArgs.safeParse(raw);
      if (!parsed.success) return null;
      return { tool, args: { query: parsed.data.query, limit: parsed.data.limit ?? 6 } };
    }
    case "search_papers": {
      const parsed = papersArgs.safeParse(raw);
      if (!parsed.success) return null;
      return { tool, args: { query: parsed.data.query, limit: parsed.data.limit ?? 8 } };
    }
    case "find_relation_evidence": {
      const parsed = relationArgs.safeParse(raw);
      if (!parsed.success) return null;
      const a = resolvePaperId(papers, parsed.data.paperA);
      const b = resolvePaperId(papers, parsed.data.paperB);
      if (!a || !b || a === b) return null;
      return { tool, args: { paperA: a, paperB: b } };
    }
    case "get_paper_context": {
      const parsed = contextArgs.safeParse(raw);
      if (!parsed.success) return null;
      const id = resolvePaperId(papers, parsed.data.paperId);
      return id ? { tool, args: { paperId: id } } : null;
    }
    case "expand_citations": {
      const parsed = expandArgs.safeParse(raw);
      if (!parsed.success) return null;
      const id = resolvePaperId(papers, parsed.data.paperId);
      if (!id) return null;
      return {
        tool,
        args: {
          paperId: id,
          direction: parsed.data.direction ?? "both",
          limit: parsed.data.limit ?? 8,
        },
      };
    }
  }
}

export function planKey(step: PlannedStep): string {
  return `${step.tool}:${JSON.stringify(step.args)}`;
}

export interface SanitizeOptions {
  /** 单轮最多几步;默认 3。补查轮通常只给 2 步。 */
  maxSteps?: number;
  /** 已经执行过的「工具 + 参数」,补查时不再重复。 */
  exclude?: ReadonlySet<string>;
}

/** 把模型的规划清洗成可执行的步骤:白名单、论文校验、去重、封顶。 */
export function sanitizePlan(
  payload: StarfieldPayload,
  raw: unknown,
  options: SanitizeOptions = {},
): PlannedStep[] {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return [];

  const maxSteps = options.maxSteps ?? 3;
  const excluded = options.exclude;
  const papers = paperCatalog(payload);
  const seen = new Set<string>();
  const steps: PlannedStep[] = [];
  for (const item of parsed.data.steps) {
    const step = validateStep(papers, item);
    if (!step) continue;
    const key = planKey(step);
    if (seen.has(key) || excluded?.has(key)) continue;
    seen.add(key);
    if (item.why) step.why = item.why.slice(0, 120);
    steps.push(step);
    if (steps.length >= maxSteps) break;
  }
  return steps;
}

export interface PlanResult {
  steps: PlannedStep[];
  /** 计划是否真的来自模型:false 时调用方可以启用确定性备用规划 */
  fromModel: boolean;
}

/**
 * 让模型规划一次。任何失败(没配模型、超时、输出不合法)都标记 fromModel=false,
 * 由调用方决定是否用备用规划 —— 问答不能因为「规划器」坏掉就没法用。
 */
export async function planAgentSteps(
  ownerId: string,
  payload: StarfieldPayload,
  question: string,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const result = await chatJson(
    {
      ownerId,
      service: "ask",
      system: PLANNER_SYSTEM,
      user: buildUserPrompt(payload, question),
      temperature: 0.1,
      maxTokens: 600,
      timeoutMs: 15_000,
      retries: 0,
      signal,
    },
    PlanSchema,
  );
  if (!result) return { steps: [], fromModel: false };
  return { steps: sanitizePlan(payload, result.value), fromModel: true };
}

export const RELATION_CUES = /关系|基线|区别|差异|比较|对比|谁引用|引用谁|沿用|继承|改进/;
export const EXTERNAL_CUES = /后来|后续|还有哪些|哪些工作|扩展|引用它|谁用了|谁引用|被谁引用|谁沿用了|沿用了它/;

export function papersMentioned(papers: PaperNode[], question: string): PaperNode[] {
  return findMentionedPapers(papers, question);
}

/**
 * 确定性备用规划。
 *
 * 只在模型不可用时启用:用问题里的信号选择工具,让 Agent 的「查证」能力
 * 不依赖模型余额。它比模型笨,但可预测、可测试,而且不会编造论文 id。
 */
export function heuristicPlan(payload: StarfieldPayload, question: string): PlannedStep[] {
  const papers = papersMentioned(paperCatalog(payload), question);
  const steps: PlannedStep[] = [];

  if (papers.length === 2 && RELATION_CUES.test(question)) {
    steps.push({
      tool: "find_relation_evidence",
      args: { paperA: papers[0]!.id, paperB: papers[1]!.id },
      why: "问题提到两篇论文并涉及关系",
    });
  }

  if (papers.length === 1 && EXTERNAL_CUES.test(question)) {
    steps.push({
      tool: "expand_citations",
      args: { paperId: papers[0]!.id, direction: "forward", limit: 8 },
      why: "问题在问后续工作",
    });
  }

  if (!steps.length) {
    steps.push({
      tool: "search_starfield",
      args: { query: question.slice(0, 120), limit: 6 },
      why: "模型不可用,用原文检索兜底",
    });
  }

  return steps.slice(0, 2);
}

const REPLANNER_SYSTEM = `你是 StellarLit 的检索补全规划器。第一轮工具已经执行完,你不回答问题,只决定「还缺什么证据、下一步补查什么」。

可用工具(只能从这里选):
${TOOL_MANUAL}

规则:
1. 最多 2 步,只补真正缺失的证据;已经有足够证据时返回 {"steps":[]}。
2. **不要重复**「已执行」里出现过的相同工具 + 参数;要换查询词、换论文,或换一种工具。
3. 关系/比较问题缺关系证据时,优先 find_relation_evidence;缺某篇论文的原文时用 get_paper_context 或 search_starfield。
4. 外部工作不足时用 expand_citations;星空里没有的主题才用 search_papers。
5. paperA、paperB、paperId 只能取清单里出现过的 id,绝不编造。
6. 每一步都要在 why 里写清补它的理由,理由要和「仍缺」对应。

只输出 JSON,不要解释:{"steps":[{"tool":"search_starfield","args":{"query":"..."},"why":"一句话理由"}]}`;

export interface ReplanInput {
  ownerId: string;
  payload: StarfieldPayload;
  question: string;
  round: number;
  executed: PlannedStep[];
  trace: AskStep[];
  sources: RetrievedSource[];
  external: string[];
  assessment: EvidenceAssessment;
  signal?: AbortSignal;
}

function buildReplanUserPrompt(input: ReplanInput): string {
  const papers = paperCatalog(input.payload)
    .slice(0, 12)
    .map((paper) => `${paper.id} 《${paper.title}》 ${paper.year || "年份未知"}`)
    .join("\n");
  const executed = input.executed
    .map((step, index) => `${index + 1}. ${step.tool} ${JSON.stringify(step.args)}${step.why ? ` —— ${step.why}` : ""}`)
    .join("\n");
  const trace = input.trace
    .map((step) => `- 第${step.round}轮 ${step.label}: ${step.state}${step.detail ? ` · ${step.detail}` : ""}`)
    .join("\n");
  const evidence = input.sources
    .slice(0, 5)
    .map((source, index) => `[${index + 1}]《${source.title}》· ${source.section}: ${source.quote.replace(/\s+/g, " ").slice(0, 110)}`)
    .join("\n");

  return `<星空>
${input.payload.starfield.name} · ${input.payload.starfield.stats.papers} 篇 / ${input.payload.starfield.stats.edges} 条边
</星空>

<论文清单>
${papers}
</论文清单>

<已执行>
${executed || "(无)"}
</已执行>

<执行结果>
${trace || "(无)"}
</执行结果>

<证据现状>
${input.assessment.stats.sources} 块原文,其中 ${input.assessment.stats.relations} 条关系证据;涉及 ${input.assessment.stats.papers} 篇论文;外部结果 ${input.assessment.stats.external} 条。
${evidence || "(无)"}
</证据现状>

<仍缺>
${input.assessment.gaps.map((gap) => `- ${gap}`).join("\n") || "(无)"}
</仍缺>

<外部线索>
${input.external.slice(0, 5).join("\n") || "(无)"}
</外部线索>

<当前是第 ${input.round} 轮补查>
问题:${input.question}`;
}

/** 让模型看着第一轮结果再规划一次;失败时由调用方退回确定性补查。 */
export async function replanAgentSteps(input: ReplanInput): Promise<PlanResult> {
  const result = await chatJson(
    {
      ownerId: input.ownerId,
      service: "ask",
      system: REPLANNER_SYSTEM,
      user: buildReplanUserPrompt(input),
      temperature: 0.1,
      maxTokens: 600,
      timeoutMs: 10_000,
      retries: 0,
      signal: input.signal,
    },
    PlanSchema,
  );
  if (!result) return { steps: [], fromModel: false };
  const exclude = new Set(input.executed.map(planKey));
  return {
    steps: sanitizePlan(input.payload, result.value, { maxSteps: 2, exclude }),
    fromModel: true,
  };
}

export interface HeuristicReplanInput {
  payload: StarfieldPayload;
  question: string;
  assessment: EvidenceAssessment;
  executed: PlannedStep[];
}

/** 模型不可用时的补查规则:优先补关系,其次补论文上下文。 */
export function heuristicReplan(input: HeuristicReplanInput): PlannedStep[] {
  const done = new Set(input.executed.map(planKey));
  const papers = papersMentioned(paperCatalog(input.payload), input.question);
  const steps: PlannedStep[] = [];
  const wantsRelation = input.assessment.gaps.some((gap) => gap.includes("关系证据"));
  const wantsExternal = input.assessment.gaps.some((gap) => gap.includes("后续或引用"));
  const add = (step: PlannedStep) => {
    const key = planKey(step);
    if (done.has(key) || steps.some((item) => planKey(item) === key)) return;
    steps.push(step);
  };

  if (wantsRelation && papers.length >= 2) {
    add({
      tool: "find_relation_evidence",
      args: { paperA: papers[0]!.id, paperB: papers[1]!.id },
      why: "补查两篇论文之间已判定的关系证据",
    });
  }

  if (wantsExternal && papers[0]) {
    add({
      tool: "expand_citations",
      args: { paperId: papers[0].id, direction: "forward", limit: 8 },
      why: "补查引用这篇论文的后续工作",
    });
  }

  for (const paper of papers.slice(0, 2)) {
    add({
      tool: "get_paper_context",
      args: { paperId: paper.id },
      why: `补读《${paper.title}》的摘要与关系边`,
    });
  }

  if (!steps.length) {
    const anchor = papers[0] ?? paperCatalog(input.payload)[0];
    if (anchor) {
      add({
        tool: "get_paper_context",
        args: { paperId: anchor.id },
        why: "命中原文过少,补读最相关论文的上下文",
      });
    }
  }

  return steps.slice(0, 2);
}
