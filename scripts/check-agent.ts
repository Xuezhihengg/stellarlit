/**
 * Agent 工作流校验。
 *
 * 不测「模型规划得好不好」(那需要稳定模型),只测**安全与链路**:
 *   - 规划产物会被白名单、论文存在性、步数上限三道闸清洗;
 *   - 执行层真的通过 MCP 调到了工具,并把结果转成带编号的证据;
 *   - 第一轮证据不足时会触发第二轮补查,并在证据足够后停止;
 *   - 关系证据与 RAG 语料共用 chunkId,不会重复;
 *   - 外部结果只进「外部线索」,不混进 [n] 角标。
 *
 * 运行:`pnpm check:agent`(已被 `pnpm check` 调用)
 */

import { executePlan } from "../src/server/agent/execute";
import { mergeSources } from "../src/server/agent/evidence";
import { assessEvidence } from "../src/server/agent/assess";
import { runAgentRounds } from "../src/server/agent/loop";
import { heuristicPlan, heuristicReplan, sanitizePlan } from "../src/server/agent/plan";
import { buildAskPrompt } from "../src/server/rag/answer";
import { retrieveSources } from "../src/server/rag/retrieve";
import { closePool, queryOne } from "../src/server/db";
import { ensureLegacyStarfieldsImported } from "../src/server/db/starfields";
import { closeRedis } from "../src/server/redis";
import type { StarfieldPayload } from "../src/types/api";
import type { PaperNode } from "../src/types/kg";

import raw from "../data/starfields/sf-1483870316-mvaava4o.json";

const payload = raw as unknown as StarfieldPayload;
const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

async function main(): Promise<void> {
  await ensureLegacyStarfieldsImported();
  // 星空可能已被首个账号接管;按实际 owner 调工具,而不是写死 legacy
  const owner = await queryOne<{ owner_id: string }>(
    "SELECT owner_id FROM starfields WHERE id = $1",
    [payload.starfield.id],
  );
  // ------------------------------------------------------------------------
  // 1. 规划清洗:白名单 / 参数 / 论文存在性 / 步数上限
  // ------------------------------------------------------------------------
  const clean = sanitizePlan(payload, {
    steps: [
      {
        tool: "find_relation_evidence",
        args: { paperA: "W2102605133", paperB: "paper:W1932624639" },
      },
      { tool: "search_starfield", args: { query: "单阶段检测", limit: 4 } },
      { tool: "get_paper_context", args: { paperId: "paper:W1483870316" } },
      { tool: "search_papers", args: { query: "object detection" } },
    ],
  });
  expect("最多保留 3 步", clean.length === 3, String(clean.length));
  expect("第 1 步是关系查询", clean[0]?.tool === "find_relation_evidence");
  expect(
    "无前缀 id 被补成 paper:",
    clean[0]?.args.paperA === "paper:W2102605133",
    String(clean[0]?.args.paperA),
  );

  const hostile = sanitizePlan(payload, {
    steps: [
      { tool: "rm_rf", args: {} },
      {
        tool: "find_relation_evidence",
        args: { paperA: "paper:W999999999", paperB: "paper:W1483870316" },
      },
      { tool: "search_starfield", args: { query: "x" } },
      { tool: "expand_citations", args: { paperId: "paper:W1483870316", limit: 999 } },
    ],
  });
  expect("未知工具与编造 id 被丢弃", hostile.length === 0, JSON.stringify(hostile));

  const deduped = sanitizePlan(payload, {
    steps: [
      { tool: "search_starfield", args: { query: "YOLO" } },
      { tool: "search_starfield", args: { query: "YOLO" } },
    ],
  });
  expect("参数完全相同的步骤去重", deduped.length === 1, String(deduped.length));

  const byTitle = sanitizePlan(payload, {
    steps: [
      {
        tool: "find_relation_evidence",
        args: {
          paperA: "You Only Look Once: Unified, Real-Time Object Detection",
          paperB: "Rich Feature Hierarchies for Accurate Object Detection and Semantic Segmentation",
        },
      },
    ],
  });
  expect("标题能解析成 id", byTitle.length === 1, JSON.stringify(byTitle));

  // ------------------------------------------------------------------------
  // 2. 备用规划:模型不可用时,规则也要选对工具
  // ------------------------------------------------------------------------
  const relationPlan = heuristicPlan(payload, "YOLO 和 SSD 是什么关系?");
  expect("关系问题选关系工具", relationPlan[0]?.tool === "find_relation_evidence");
  expect(
    "关系问题锁定了两篇真实论文",
    relationPlan[0]?.args.paperA === "paper:W1483870316" &&
      relationPlan[0]?.args.paperB === "paper:W3106250896",
    JSON.stringify(relationPlan[0]?.args),
  );

  const externalPlan = heuristicPlan(payload, "后来有哪些工作沿用了 YOLO?");
  expect("后续工作选引文工具", externalPlan[0]?.tool === "expand_citations");

  const genericPlan = heuristicPlan(payload, "这片星空的整体脉络是什么?");
  expect("普通问题退回原文检索", genericPlan[0]?.tool === "search_starfield");

  // ------------------------------------------------------------------------
  // 3. 执行:真的走 MCP,证据带 chunkId
  // ------------------------------------------------------------------------
  const activity: string[] = [];
  const outcome = await executePlan(payload, clean, (step) => {
    activity.push(`${step.slot}:${step.state}`);
  }, { ownerId: owner?.owner_id ?? "legacy" });
  expect("三步都执行了", outcome.trace.length === 3, String(outcome.trace.length));
  expect("轨迹先 running 后结束", activity.length === 6, activity.join(","));
  expect(
    "全部成功",
    outcome.trace.every((step) => step.state === "done"),
    outcome.trace.map((step) => `${step.tool}=${step.state}`).join(","),
  );

  const relation = outcome.sources.find((source) => source.section === "relation");
  expect("关系证据来自真实边", Boolean(relation?.chunkId.startsWith("edge:")), relation?.chunkId);
  expect(
    "关系证据带两篇论文",
    Boolean(relation && relation.paperIds.length === 2),
  );
  expect(
    "检索证据带 chunkId",
    outcome.sources.some((source) => source.chunkId.includes(":abstract")),
  );

  // ------------------------------------------------------------------------
  // 4. 合并:与默认检索去重、总量有上限
  // ------------------------------------------------------------------------
  const base = await retrieveSources(payload, "YOLO 单阶段检测", 8);
  const merged = mergeSources(base, [...base, ...outcome.sources]);
  expect("合并后不出现重复 chunkId", new Set(merged.map((s) => s.chunkId)).size === merged.length);
  expect(
    "合并后总量不超过 12",
    merged.length <= 12,
    String(merged.length),
  );
  const abstract = base.find((source) => source.section === "abstract");
  if (abstract) {
    const sectionDeduped = mergeSources(base, [
      { ...abstract, chunkId: "agent:duplicate-abstract" },
    ]);
    expect(
      "同一论文同一章节不重复",
      sectionDeduped.length === base.length,
      `${base.length} -> ${sectionDeduped.length}`,
    );
  }

  // ------------------------------------------------------------------------
  // 5. 提示词:外部线索与角标边界
  // ------------------------------------------------------------------------
  const prompt = buildAskPrompt("后来谁沿用了 YOLO?", merged, 0, [
    "《Faster R-CNN》· 2015 · 被引 100(OpenAlex 结果,未并入本片星空)",
  ]);
  expect("提示词包含外部线索段", prompt.includes("<外部线索>"));
  expect("提示词明确禁止外部结果加角标", prompt.includes("不要给它们加 [n] 角标"));
  expect("提示词包含问题", prompt.includes("后来谁沿用了 YOLO?"));

  // ------------------------------------------------------------------------
  // 6. 闭环:第一轮缺关系证据 → 第二轮补查 → 证据足够后停止
  // ------------------------------------------------------------------------
  const paperA = payload.graph.nodes.find(
    (node): node is PaperNode => node.kind === "paper" && node.id === "paper:W1483870316",
  );
  const paperB = payload.graph.nodes.find(
    (node): node is PaperNode => node.kind === "paper" && node.id === "paper:W3106250896",
  );
  expect("样例论文存在", Boolean(paperA && paperB));

  if (paperA && paperB) {
    const relationQuestion = `${paperA.title} 和 ${paperB.title} 是什么关系?`;
    const empty = assessEvidence(payload, relationQuestion, [], []);
    expect("空证据被判为不足", !empty.enough);
    expect(
      "关系问题被识别为关系意图",
      empty.intent === "relation" || empty.intent === "comparison",
      empty.intent,
    );
    expect(
      "缺口指出关系证据",
      empty.gaps.some((gap) => gap.includes("关系证据")),
      empty.gaps.join(" / "),
    );

    const nextPlan = heuristicReplan({
      payload,
      question: relationQuestion,
      assessment: empty,
      executed: [],
    });
    expect(
      "确定性补查优先查关系",
      nextPlan[0]?.tool === "find_relation_evidence",
      JSON.stringify(nextPlan),
    );

    const abstractSource = {
      chunkId: "test:abstract:a",
      paperId: paperA.id,
      paperIds: [paperA.id],
      title: paperA.title,
      section: "abstract" as const,
      year: paperA.year || undefined,
      text: "YOLO 把目标检测建模为单阶段回归。",
      quote: "YOLO 把目标检测建模为单阶段回归。",
    };
    const relationChunk = {
      chunkId: "test:relation:a-b",
      paperId: paperA.id,
      paperIds: [paperA.id, paperB.id],
      title: `${paperA.title} ↔ ${paperB.title}`,
      section: "relation" as const,
      year: paperA.year || undefined,
      text: "两者都是单阶段检测路线,SSD 在 YOLO 之后提出。",
      quote: "两者都是单阶段检测路线。",
    };
    const liveDecisions: string[] = [];
    const loop = await runAgentRounds({
      payload,
      question: relationQuestion,
      base: [],
      initialPlan: {
        steps: [{ tool: "search_starfield", args: { query: "single stage detection", limit: 4 } }],
        fromModel: true,
      },
      execute: async (steps, round, startSlot) => ({
        sources: round === 1 ? [abstractSource] : [relationChunk],
        external: [],
        trace: steps.map((step, index) => ({
          slot: startSlot + index,
          round,
          tool: step.tool,
          label: "检索原文",
          state: "done" as const,
          detail: "1 块",
        })),
      }),
      replan: async () => ({
        steps: [
          {
            tool: "find_relation_evidence" as const,
            args: { paperA: paperA.id, paperB: paperB.id },
          },
        ],
        fromModel: true,
      }),
      onDecision: (decision) => liveDecisions.push(`${decision.action}:${decision.code}`),
    });

    expect("闭环执行了两轮", loop.rounds === 2, String(loop.rounds));
    expect(
      "第一轮判定继续",
      loop.decisions[0]?.action === "continue",
      JSON.stringify(loop.decisions[0]),
    );
    expect(
      "第二轮判定停止",
      loop.decisions[1]?.action === "stop",
      JSON.stringify(loop.decisions[1]),
    );
    expect("证据足够后停止", loop.stopReason === "enough", loop.stopReason);
    expect("补到了关系证据", loop.sources.some((source) => source.section === "relation"));
    expect("决策通过回调实时发出", liveDecisions.length === 2, liveDecisions.join(","));
    expect(
      "两轮轨迹都带轮次",
      loop.trace.some((step) => step.round === 1) && loop.trace.some((step) => step.round === 2),
    );

    // 第一轮工具没有新增证据时,不应立刻放弃:换一种工具再查一次
    const retryLoop = await runAgentRounds({
      payload,
      question: relationQuestion,
      base: [],
      initialPlan: {
        steps: [{ tool: "search_starfield", args: { query: "empty result", limit: 4 } }],
        fromModel: true,
      },
      execute: async (steps, round, startSlot) => ({
        sources: round === 1 ? [] : [relationChunk],
        external: [],
        trace: steps.map((step, index) => ({
          slot: startSlot + index,
          round,
          tool: step.tool,
          label: "检索原文",
          state: round === 1 ? ("empty" as const) : ("done" as const),
          detail: round === 1 ? "0 块" : "1 块",
        })),
      }),
      replan: async () => ({
        steps: [
          {
            tool: "find_relation_evidence" as const,
            args: { paperA: paperA.id, paperB: paperB.id },
          },
        ],
        fromModel: true,
      }),
    });
    expect(
      "首轮无新增仍会补查一次",
      retryLoop.decisions[0]?.action === "continue" && retryLoop.rounds === 2,
      JSON.stringify(retryLoop.decisions),
    );
    expect("补查后仍能停止", retryLoop.stopReason === "enough", retryLoop.stopReason);
  }

  if (problems.length > 0) {
    console.error("Agent 工作流校验失败:\n" + problems.map((p) => `  x ${p}`).join("\n"));
    await closeRedis();
    await closePool();
    process.exit(1);
  }

  console.log(
    `Agent 工作流一致(规划清洗 / 工具执行 / 证据合并 / 提示词 共 ${checks} 项)`,
  );
  await closeRedis();
  await closePool();
}

void main();
