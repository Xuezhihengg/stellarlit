/**
 * 语义关系判定管道。
 *
 * 两段式,顺序不能反:
 *
 *   ① 硬约束过滤(确定性、不花 token)
 *      年份差、互引检查、共享任务 …… 把候选从 O(n²) 砍到可接受的量级。
 *      这一步完全不会幻觉,而且是**唯一能保证不出现明显错误**的一步。
 *
 *   ② 模型判定(带 rubric 与反例)
 *      只在少量候选上跑,并要求给出原文证据片段。
 *
 * 没有大模型密钥时,第②步降级为启发式打分,并在报告里如实标注 ——
 * 界面上会显示「启发式判定」而不是假装有 AI 结论。
 */

import { z } from "zod";

import type { Evidence, GraphEdge, Provenance, RelationPreset } from "@/types/kg";

import { chatJson, llmAvailable } from "../llm/client";
import type { OaWork } from "../sources/openalex";
import { edgeKindOf } from "./presets";

const now = (): string => new Date().toISOString();

export interface RelationReport {
  /** 每个预设:候选数 / 判定数 / 命中数 */
  perPreset: Record<
    string,
    { candidates: number; judged: number; matched: number; mode: "llm" | "heuristic" }
  >;
  /** 被核验失败的引用片段数 —— 这个数字本身就是反幻觉能力的证据 */
  rejectedQuotes: number;
}

/** 判定过程中用到的、可由数据源直接算出的事实。 */
interface PairFeatures {
  i: number;
  j: number;
  citesIJ: boolean;
  citesJI: boolean;
  yearGap: number;
  sharedTopics: string[];
  topicOverlap: number;
  titleSim: number;
}

const topicIdsOf = (w: OaWork): Set<string> =>
  new Set(w.fields.filter((f) => f.level === "topic").map((f) => f.id));

/** 词集合的 Jaccard 相似度。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const normTitle = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function bigramDice(a: string, b: string): number {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  let total = 0;
  for (const [g, c] of gx) {
    total += c;
    const d = gy.get(g);
    if (d) inter += Math.min(c, d);
  }
  for (const c of gy.values()) total += c;
  return total ? (2 * inter) / total : 0;
}

/**
 * 生成候选对。
 *
 * 这里刻意**不做全量笛卡尔积**:候选只在「有引用关系」或「共享主题」的论文之间存在。
 * 一篇论文与它毫不相关的另一篇,不需要花任何算力去证明它们不相关。
 */
function generatePairs(papers: OaWork[]): PairFeatures[] {
  const index = new Map<string, number>();
  papers.forEach((w, i) => index.set(w.id, i));

  const cites = new Set<string>();
  papers.forEach((w, i) => {
    for (const ref of w.referencedWorks) {
      const j = index.get(ref);
      if (j !== undefined && j !== i) cites.add(`${i}|${j}`);
    }
  });

  const topics = papers.map(topicIdsOf);

  // 按主题倒排:只在共享主题的论文之间两两配对
  const byTopic = new Map<string, number[]>();
  topics.forEach((set, i) => {
    for (const t of set) {
      const list = byTopic.get(t);
      if (list) list.push(i);
      else byTopic.set(t, [i]);
    }
  });

  const seen = new Set<string>();
  const pairs: PairFeatures[] = [];

  const push = (i: number, j: number) => {
    if (i === j) return;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}|${b}`;
    if (seen.has(key)) return;
    seen.add(key);

    const wa = papers[a];
    const wb = papers[b];
    if (!wa || !wb) return;

    const shared = [...topics[a] ?? []].filter((t) => topics[b]?.has(t));
    pairs.push({
      i: a,
      j: b,
      citesIJ: cites.has(`${a}|${b}`),
      citesJI: cites.has(`${b}|${a}`),
      yearGap: Math.abs((wa.year || 0) - (wb.year || 0)),
      sharedTopics: shared,
      topicOverlap: jaccard(topics[a] ?? new Set(), topics[b] ?? new Set()),
      titleSim: bigramDice(wa.title, wb.title),
    });
  };

  for (const list of byTopic.values()) {
    // 单个主题下的论文太多时先截断:一个主题挂几千篇说明它区分度太低
    const capped = list.length > 60 ? list.slice(0, 60) : list;
    for (let x = 0; x < capped.length; x++) {
      for (let y = x + 1; y < capped.length; y++) {
        const i = capped[x];
        const j = capped[y];
        if (i === undefined || j === undefined) continue;
        push(i, j);
      }
    }
  }
  for (const k of cites) {
    const [a, b] = k.split("|").map(Number);
    if (a !== undefined && b !== undefined) push(a, b);
  }

  return pairs;
}

/** 硬约束:全部是确定性规则,不涉及模型。返回 false 表示这个候选连送审的资格都没有。 */
function passesHardConstraints(f: PairFeatures, preset: RelationPreset): boolean {
  const c = preset.hardConstraints;

  if (c.maxYearGap !== undefined && f.yearGap > c.maxYearGap) return false;

  if (c.requireCitation && !f.citesIJ && !f.citesJI) return false;

  if (c.requireMutualNonCitation && (f.citesIJ || f.citesJI)) return false;

  if (c.requireSharedTask && f.sharedTopics.length === 0) return false;

  if (c.minSimilarity !== undefined && f.topicOverlap < c.minSimilarity) return false;

  return true;
}

/**
 * 启发式打分 —— 既用于给候选排序(决定谁先送到模型那里),
 * 也在没有大模型时作为降级判定。
 *
 * 它刻意做得很保守:只利用数据源里已有的事实(引用、年份、主题、标题),
 * 不给任何「读起来像」的判断。宁可少给几条,也不制造无法核验的结论。
 */
function heuristicScore(f: PairFeatures, preset: RelationPreset): number {
  switch (preset.id) {
    case "baseline":
    case "extends": {
      if (!f.citesIJ && !f.citesJI) return 0;
      const recency = 1 - Math.min(1, f.yearGap / 8);
      return 0.35 + 0.4 * recency + 0.25 * Math.min(1, f.topicOverlap * 3);
    }
    case "contemporary": {
      if (f.citesIJ || f.citesJI) return 0;
      const closeness = 1 - f.yearGap / 3;
      return 0.3 + 0.45 * closeness + 0.25 * Math.min(1, f.topicOverlap * 3);
    }
    case "similar":
      return 0.25 + 0.5 * Math.min(1, f.topicOverlap * 2.5) + 0.25 * f.titleSim;
    case "alternative":
      return 0.3 + 0.4 * Math.min(1, f.sharedTopics.length / 2) + 0.3 * (1 - f.topicOverlap);
    case "contradicts":
      // 矛盾关系无法从元数据推断,只有模型读过摘要才可能判定。
      // 这里返回 0 是诚实的选择:不猜。
      return 0;
    default:
      return 0;
  }
}

const JudgeSchema = z.object({
  match: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  evidence: z
    .array(
      z.object({
        paperId: z.string(),
        quote: z.string(),
      }),
    )
    .optional(),
});

const JUDGE_SYSTEM = `你是一名严谨的学术文献分析助手。你的任务是在两篇论文之间判定一种**指定的关系**。

你必须遵守的规则:
1. 只依据给定的标题与摘要判断,不得引入外部知识或推测论文里没写的内容。
2. 提供的「反例」是判断边界,遇到反例描述的情况必须判为不成立。
3. 如果证据不足,判 match = false。宁可漏判,不要误判。
4. evidence 里必须是**原文中逐字出现的片段**,不能改写、不能概括。找不到原文片段就不要给。

只输出 JSON,格式:
{"match": true|false, "confidence": 0-1, "rationale": "一句话理由", "evidence": [{"paperId": "...", "quote": "..."}]}`;

/** 把证据片段核验回原文。模型编造的引用会在这里被拦下。 */
function verifyQuotes(
  raw: Array<{ paperId: string; quote: string }>,
  byId: Map<string, OaWork>,
): { evidence: Evidence[]; rejected: number } {
  const evidence: Evidence[] = [];
  let rejected = 0;

  for (const item of raw) {
    const work = byId.get(item.paperId.replace(/^paper:/, ""));
    const quote = item.quote.trim();
    if (!work || quote.length < 12) {
      rejected++;
      continue;
    }

    // 归一化空白后做子串匹配 —— 这是「引用核验」最简形式的实现
    const haystack = `${work.title} ${work.abstract ?? ""}`.replace(/\s+/g, " ");
    const needle = quote.replace(/\s+/g, " ");
    if (!haystack.includes(needle)) {
      rejected++;
      continue;
    }

    const isInTitle = work.title.replace(/\s+/g, " ").includes(needle);
    evidence.push({
      kind: "span",
      paperId: `paper:${work.id}`,
      section: isInTitle ? "title" : "abstract",
      quote,
      // 摘要尚无字符级切块,先用 0 长度定位占位;接入全文切块后改为真实偏移
      locator: { chunkId: `abstract:${work.id}`, start: 0, end: quote.length },
      score: 0.9,
    });
  }

  return { evidence, rejected };
}

function pairPrompt(f: PairFeatures, a: OaWork, b: OaWork, preset: RelationPreset): string {
  const relation = f.citesIJ
    ? `${a.id} 引用了 ${b.id}`
    : f.citesJI
      ? `${b.id} 引用了 ${a.id}`
      : "两者之间没有引用关系";

  const fmt = (w: OaWork) =>
    [
      `id: ${w.id}`,
      `标题: ${w.title}`,
      `年份: ${w.year}`,
      w.venue ? `发表: ${w.venue}` : null,
      `被引: ${w.citedByCount}`,
      `摘要: ${(w.abstract ?? "(无摘要)").slice(0, 1200)}`,
    ]
      .filter(Boolean)
      .join("\n");

  return `## 待判定的关系:${preset.label}(${preset.labelEn})

判定标准:
${preset.definition}

反例(出现以下情况必须判为不成立):
${preset.negativeExamples}

## 客观事实
${relation}
年份差:${f.yearGap} 年
共享主题:${f.sharedTopics.length ? f.sharedTopics.join(", ") : "(无)"}

## 论文 A
${fmt(a)}

## 论文 B
${fmt(b)}

请判定:A 与 B 是否构成「${preset.label}」关系。注意关系的方向性:${
    preset.directed ? "有向" : "无向"
  }。`;
}

export interface RelationPipelineOptions {
  presets: RelationPreset[];
  /** 每个预设最多送审多少对候选 */
  candidateLimit?: number;
  /** 每篇种子论文最多保留多少条该关系的边 */
  perSeedLimit?: number;
  seedOaIds?: string[];
  onProgress?: (msg: string) => void;
}

export async function buildSemanticEdges(
  papers: OaWork[],
  opts: RelationPipelineOptions,
): Promise<{ edges: GraphEdge[]; report: RelationReport }> {
  const { presets, candidateLimit = 40, seedOaIds = [] } = opts;
  const byId = new Map(papers.map((w) => [w.id, w]));
  const pairs = generatePairs(papers);
  const useLlm = llmAvailable();

  const edges: GraphEdge[] = [];
  const report: RelationReport = { perPreset: {}, rejectedQuotes: 0 };
  const perSeedCount = new Map<string, number>();

  for (const preset of presets) {
    if (!preset.enabled) continue;

    const mode: "llm" | "heuristic" = useLlm && preset.id !== "contradicts" ? "llm" : "heuristic";
    report.perPreset[preset.id] = { candidates: 0, judged: 0, matched: 0, mode };

    const eligible = pairs.filter((f) => passesHardConstraints(f, preset));
    report.perPreset[preset.id]!.candidates = eligible.length;

    const ranked = eligible
      .map((f) => ({ f, s: heuristicScore(f, preset) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, candidateLimit);

    for (const { f, s } of ranked) {
      const a = papers[f.i];
      const b = papers[f.j];
      if (!a || !b) continue;

      // 每篇种子论文的配额:防止一个高产预设淹没整张图
      const touchesSeed =
        seedOaIds.length === 0 || seedOaIds.includes(a.id) || seedOaIds.includes(b.id);
      if (!touchesSeed) continue;
      const key = seedOaIds.includes(b.id) ? b.id : a.id;
      if ((perSeedCount.get(`${preset.id}:${key}`) ?? 0) >= preset.maxPerSeed) continue;

      let matched = false;
      let confidence = s;
      let rationale =
        mode === "heuristic"
          ? `启发式判定(未配置大模型):依据引用关系、年份差与主题重叠度。检测到 ${f.sharedTopics.length} 个共享主题。`
          : "";
      let evidence: Evidence[] = [];

      if (mode === "llm") {
        const judged = await chatJson(
          {
            system: JUDGE_SYSTEM,
            user: pairPrompt(f, a, b, preset),
            temperature: 0.05,
            maxTokens: 900,
          },
          JudgeSchema,
        );
        report.perPreset[preset.id]!.judged++;
        if (!judged) continue;

        matched = judged.value.match;
        confidence = judged.value.confidence ?? 0.7;
        rationale = judged.value.rationale ?? "";
        const verified = verifyQuotes(judged.value.evidence ?? [], byId);
        report.rejectedQuotes += verified.rejected;
        evidence = verified.evidence;
      } else {
        matched = preset.id === "contradicts" ? false : s >= 0.55;
        // 启发式判定没有原文证据,但必须留下「依据什么算出来的」的结构化事实
        if (matched) {
          evidence = [
            {
              kind: "metadata",
              note: `引用关系:${f.citesIJ ? "A→B" : f.citesJI ? "B→A" : "无"};共享主题 ${f.sharedTopics.length} 个;标题相似度 ${(f.titleSim * 100).toFixed(0)}%`,
              fields: {
                yearGap: f.yearGap,
                topicOverlap: Number(f.topicOverlap.toFixed(3)),
                titleSimilarity: Number(f.titleSim.toFixed(3)),
              },
            },
          ];
        }
      }

      if (!matched) continue;

      // 不变式:语义边必须有证据。没有证据的判定不入库。
      if (evidence.length === 0) continue;

      const sourceId = `paper:${a.id}`;
      const targetId = `paper:${b.id}`;
      const provenance: Provenance =
        mode === "llm"
          ? {
              source: "llm",
              ref: `${a.id}->${b.id}`,
              promptVersion: preset.promptVersion,
              at: now(),
            }
          : { source: "algorithm", ref: `heuristic:${preset.id}`, at: now() };

      edges.push({
        id: `${sourceId}|${edgeKindOf(preset.id)}|${targetId}`,
        kind: edgeKindOf(preset.id) as GraphEdge["kind"],
        layer: "semantic",
        source: sourceId,
        target: targetId,
        directed: preset.directed,
        weight: confidence,
        confidence,
        evidence,
        rationale,
        provenance,
      });

      perSeedCount.set(`${preset.id}:${key}`, (perSeedCount.get(`${preset.id}:${key}`) ?? 0) + 1);
      report.perPreset[preset.id]!.matched++;
    }
  }

  return { edges, report };
}

/** 供图例与设置页使用:预设 → 视觉编码。 */
export function legendOf(presets: RelationPreset[]): Array<{
  id: string;
  label: string;
  description: string;
  tone: string;
  dash?: string;
  directed: boolean;
}> {
  return presets
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      tone: p.visual.tone,
      dash: p.visual.dash,
      directed: p.directed,
    }));
}
