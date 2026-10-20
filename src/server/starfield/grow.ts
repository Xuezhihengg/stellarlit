/**
 * 星空生长 —— 从一篇种子论文出发,长出一整片星空。
 *
 * 关键设计:星空是**累积**的。
 * 同一片星空下可以多次输入种子,每次只把新论文并进来,老星体留在原地。
 * 这要求三件事同时成立:
 *   1. 原始邻域按种子缓存,重复构建几乎不发请求
 *   2. 老节点的坐标作为锚点参与增量松弛,而不是全量重排
 *   3. 社区重聚类后做编号对齐,避免颜色整体乱跳
 */

import type { BuildMeta, StarfieldPayload } from "@/types/api";
import type { Graph, GraphEdge, GraphLayout, RelationPreset } from "@/types/kg";
import type { SeedEntry, Starfield } from "@/types/starfield";

import { cached } from "../cache";
import { buildGraph, dedupe, type PreviousState } from "../graph/build";
import { capabilityReport } from "../model-settings";
import type { RelationReport } from "../relations/pipeline";
import { buildSemanticEdges } from "../relations/pipeline";
import { BUILTIN_PRESETS } from "../relations/presets";
import { getCitingWorks, getWorkById, getWorksByIds, type OaWork } from "../sources/openalex";
import { s2Neighborhood } from "../sources/semantic-scholar";
import { assessQuality, emptyQualitySummary, recordQuality } from "../sources/quality";
import { loadStarfield, saveStarfield } from "./store";

/**
 * 结构核:向后 / 向前各取被引量最高的几篇。
 *
 * 这三篇不构成"研究全景",它们是**锚点** —— 让星空有骨架、有时间方向,
 * 也方便用户一眼确认"系统找对方向了没有"。
 * 早先的版本把整个引文邻域(上百篇)都铺到图上,结果是:
 * 画面上全是引用线,真正有信息量的关系反倒被淹没。
 */
const CORE_BACKWARD = 3;
const CORE_FORWARD = 3;

/**
 * 候选池:语义判定的**输入范围**,不等于入图范围。
 *
 * 池子要足够宽,才找得到"同任务异方法""思路类似"这类跨分支的工作;
 * 但池子里的论文只有被判定确认有关系,才会成为图上的节点。
 * 抓取是免费的(上游无密钥、且按种子缓存),判定才是要花钱的那一步。
 */
const DEFAULT_POOL = 40;

/**
 * 每类关系默认送审多少对。
 *
 * 这个数字是**直接用钱和换图**的旋钮:它乘以预设数量、再除以批大小,
 * 就是一次冷启动的模型调用次数。12 对应的实测是
 * 「约 12~15 次调用 / 11 秒 / 三万六千 token / 图上十几篇论文」——
 * 对演示够用,而且排序改进之后命中率已经明显提高。
 * 调大能长出一张更密的语义图,代价接近线性。
 */
const DEFAULT_JUDGE_DEPTH = 12;

/** 传递扩展默认层数。两层是"图能长大"与"成本可控"之间的折中。 */
const DEFAULT_EXPAND_DEPTH = 2;

const currentYear = () => new Date().getFullYear();

/**
 * 展开一篇种子的引文邻域,并按种子缓存。
 *
 * 为什么按种子缓存而不是按星空缓存:同一篇论文出现在两片星空里时,
 * 上游数据完全相同,缓存可以复用。
 *
 * 缓存里**分别保留向后与向前**两个数组,而不是混成一个:
 * 选结构核时要按方向各取被引量最高的三篇,方向一旦混掉就选不出来了。
 */
export interface Neighborhood {
  seedId: string;
  seed: OaWork;
  backward: OaWork[];
  forward: OaWork[];
}

async function neighborhoodOf(seedId: string, pool: number): Promise<Neighborhood | null> {
  return cached("neighborhood", `${seedId}-p${pool}`, async () => {
    /**
     * 主源失败时切到 Semantic Scholar。
     *
     * 切的是**整个邻域**,不是某一次请求 —— 混用两个源会让同一篇论文
     * 出现两份记录、id 空间也对不上。要么 OpenAlex、要么 S2,
     * 一次建图之内保持一致。
     */
    try {
      return await openAlexNeighborhood(seedId, pool);
    } catch (e) {
      const fallback = await s2Neighborhood(seedId, pool);
      if (!fallback) throw e;
      return { seedId, ...fallback } satisfies Neighborhood;
    }
  });
}

async function openAlexNeighborhood(seedId: string, pool: number): Promise<Neighborhood | null> {
  {
    const seed = await getWorkById(seedId);
    if (!seed) return null;

    // 向后:它引用了谁(取它自己记录的 references)
    const backwardIds = seed.referencedWorks.slice(0, pool);
    const backward = backwardIds.length ? await getWorksByIds(backwardIds) : [];

    // 向前:谁引用了它。按被引量降序 —— 高被引的引用者才是主干。
    let forward: OaWork[] = [];
    try {
      forward = await getCitingWorks(seedId, pool);
    } catch {
      // 向前引用失败不应该让整次构建失败:向后邻域本身已经能构成一张合法的星图
      forward = [];
    }

    return { seedId, seed, backward, forward } satisfies Neighborhood;
  }
}

/**
 * 选出结构核。
 *
 * 规则很直白:每个种子的向后与向前**各取被引量最高的三篇**。
 * 用被引量而不是年份或随机,是因为高被引的邻居最可能是用户想确认方向是否正确的那些。
 *
 * 已知取舍:一篇刚发表、还没积累引用的工作,在别人的星图里几乎不可能进入结构核。
 * 这是"按引用量取"的固有代价 —— 它的补偿在语义层:新工作往往正是靠
 * 「同任务异方法」这类关系被拉进来的,而那类判定不看被引量。
 */
function selectCore(neighborhoods: Neighborhood[], pool: ReadonlyMap<string, OaWork>): OaWork[] {
  const keep = new Set<string>();
  const byCitations = (a: OaWork, b: OaWork) => b.citedByCount - a.citedByCount;

  for (const n of neighborhoods) {
    keep.add(n.seed.id);
    n.backward
      .filter((w) => pool.has(w.id))
      .sort(byCitations)
      .slice(0, CORE_BACKWARD)
      .forEach((w) => keep.add(w.id));
    n.forward
      .filter((w) => pool.has(w.id))
      .sort(byCitations)
      .slice(0, CORE_FORWARD)
      .forEach((w) => keep.add(w.id));
  }

  return [...pool.values()].filter((w) => keep.has(w.id));
}

/**
 * 按预算裁剪。
 *
 * 裁剪依据是**连通度**(被引量 + 与已有的引用关系),不是时间或随机:
 * 保留主干、丢掉长尾,星图的骨架才是清晰的。
 */
function applyBudget(papers: OaWork[], budget: number, mustKeep: Set<string>): OaWork[] {
  if (papers.length <= budget) return papers;

  const inSet = new Set(papers.map((w) => w.id));
  const degree = new Map<string, number>();
  for (const w of papers) {
    let d = 0;
    for (const r of w.referencedWorks) if (inSet.has(r)) d++;
    degree.set(w.id, d);
  }

  const ranked = [...papers].sort((a, b) => {
    const da = (degree.get(a.id) ?? 0) * 3 + Math.log10(a.citedByCount + 1) * 4;
    const db = (degree.get(b.id) ?? 0) * 3 + Math.log10(b.citedByCount + 1) * 4;
    return db - da;
  });

  const kept: OaWork[] = [];
  const keptIds = new Set<string>();
  for (const w of ranked) {
    if (kept.length >= budget) break;
    kept.push(w);
    keptIds.add(w.id);
  }
  // 种子无论如何必须在场,否则整张图就失去了圆心
  for (const w of papers) {
    if (mustKeep.has(w.id) && !keptIds.has(w.id)) {
      kept.push(w);
      keptIds.add(w.id);
    }
  }
  return kept;
}

function previousStateFrom(payload: StarfieldPayload | null): PreviousState | undefined {
  if (!payload) return undefined;

  const layout: GraphLayout = payload.layout;
  const communityOf: Record<string, number> = {};
  for (const edge of payload.graph.edges) {
    if (edge.kind === "BELONGS_TO" && edge.source.startsWith("paper:")) {
      const idx = Number(edge.target.replace("community:", ""));
      if (Number.isFinite(idx)) communityOf[edge.source] = idx;
    }
  }
  if (!Object.keys(layout).length) return undefined;
  return { layout, communityOf };
}

/** 把语义边并入图谱,并重算统计。derived 层不动 —— 它是 buildGraph 的产物。 */
function mergeSemanticEdges(graph: Graph, semantic: GraphEdge[]): Graph {
  // 同一对节点同一关系只保留一条(不变式 5)
  const byId = new Map<string, GraphEdge>();
  for (const e of graph.edges) byId.set(e.id, e);
  for (const e of semantic) {
    const existing = byId.get(e.id);
    if (existing) {
      // 重复判定时取置信度更高者,并合并证据
      if (e.confidence >= existing.confidence) {
        byId.set(e.id, { ...e, evidence: [...existing.evidence, ...e.evidence] });
      } else {
        byId.set(e.id, { ...existing, evidence: [...existing.evidence, ...e.evidence] });
      }
    } else {
      byId.set(e.id, e);
    }
  }

  const edges = [...byId.values()];
  const byLayer = { structural: 0, semantic: 0, derived: 0 };
  for (const e of edges) byLayer[e.layer]++;

  const papers = graph.nodes.filter((n) => n.kind === "paper").length;
  return {
    nodes: graph.nodes,
    edges,
    stats: {
      papers,
      edges: edges.length,
      communities: graph.nodes.filter((n) => n.kind === "community").length,
      domains: graph.nodes.filter((n) => n.kind === "domain").length,
      byLayer,
    },
  };
}

function starfieldId(seedIds: string[]): string {
  const stamp = Date.now().toString(36);
  const slug = seedIds
    .slice(0, 2)
    .map((s) => s.replace(/^W/, ""))
    .join("-");
  return `sf-${slug}-${stamp}`;
}

export interface GrowOptions {
  starfieldId?: string;
  seedPaperId: string;
  name?: string;
  /** 候选池宽度:每个种子向后 / 向前各抓多少篇(不等于入图数量) */
  pool?: number;
  /** 不需要判定的论文数上限;语义判定命中的论文不受此限 */
  budget?: number;
  /** 每类关系送审多少对候选 —— 直接决定模型成本与语义图的稠密程度 */
  judgeDepth?: number;
  /**
   * 传递扩展的层数。
   *
   * 一层:种子和结构核向外找一圈,图长到"核心 + 一圈"就停了(实测 18 篇)。
   * 两层:第一轮命中的论文成为新的探索中心,再向外长一圈 —— 图才真正"生长"起来。
   * 不建议更深:每多一层,候选量与调用量都接近翻倍,而边际收益衰减得很快
   * (越往外,与种子的关联越弱,判定为成立的比例也越低)。
   */
  depth?: number;
  /** 用户在设置页改写过的关系预设;缺省时用内置的那一份 */
  presets?: RelationPreset[];
}

/**
 * 构建过程中的事件。
 *
 * 这条流同时服务两件事:**传递扩展需要知道每一轮长出了什么**,
 * **流式返回需要把中间结果推给前端**。用同一条事件流而不是两套回调,
 * 是为了让"非流式"和"流式"永远走同一段代码 —— 否则两条路径迟早会跑偏。
 */
export type GrowEvent =
  | {
      type: "structure";
      starfield: Starfield;
      graph: Graph;
      layout: GraphLayout;
      presets: RelationPreset[];
    }
  | { type: "graph"; graph: Graph; layout: GraphLayout }
  | {
      type: "progress";
      round: number;
      depth: number;
      judged: number;
      matched: number;
      llmCalls: number;
      estimatedTokens: number;
    }
  | { type: "done"; payload: StarfieldPayload }
  | { type: "error"; message: string };

function sumReports(target: RelationReport, add: RelationReport): void {
  target.rejectedQuotes += add.rejectedQuotes;
  target.llmCalls += add.llmCalls;
  target.estimatedTokens += add.estimatedTokens;
  target.cacheHits += add.cacheHits;
  target.batchFallbacks += add.batchFallbacks;
  target.judgedPairs.push(...add.judgedPairs);
  for (const [id, stat] of Object.entries(add.perPreset)) {
    const cur = target.perPreset[id];
    if (!cur) {
      target.perPreset[id] = { ...stat };
      continue;
    }
    cur.candidates += stat.candidates;
    cur.judged += stat.judged;
    cur.matched += stat.matched;
  }
}

const emptyReport = (): RelationReport => ({
  perPreset: {},
  rejectedQuotes: 0,
  llmCalls: 0,
  estimatedTokens: 0,
  cacheHits: 0,
  batchFallbacks: 0,
  judgedPairs: [],
});

async function* growStarfieldStream(opts: GrowOptions): AsyncGenerator<GrowEvent> {
  const started = Date.now();
  const poolSize = Math.max(6, Math.min(200, opts.pool ?? DEFAULT_POOL));
  const depth = Math.max(1, Math.min(3, opts.depth ?? DEFAULT_EXPAND_DEPTH));
  const judgeDepth = Math.max(4, Math.min(40, opts.judgeDepth ?? DEFAULT_JUDGE_DEPTH));
  const seedOaId = opts.seedPaperId.replace(/^paper:/, "");
  const presets: RelationPreset[] = opts.presets?.length ? opts.presets : BUILTIN_PRESETS;

  const existing = opts.starfieldId ? await loadStarfield(opts.starfieldId) : null;

  // 既有星空里的所有种子都要在场 —— 累积构建的前提
  const allSeedIds = [
    ...new Set([
      ...(existing?.starfield.seeds.map((s) => s.paperId.replace(/^paper:/, "")) ?? []),
      seedOaId,
    ]),
  ];

  // ---------- 候选池 ----------
  const neighborhoods: Neighborhood[] = [];
  const merged = new Map<string, OaWork>();
  for (const id of allSeedIds) {
    const n = await neighborhoodOf(id, poolSize);
    if (!n) continue;
    neighborhoods.push(n);
    for (const w of [n.seed, ...n.backward, ...n.forward]) {
      if (!merged.has(w.id)) merged.set(w.id, w);
    }
  }

  // ---------- 质量闸门 ----------
  const quality = emptyQualitySummary();
  const passed: OaWork[] = [];
  for (const w of merged.values()) {
    const report = assessQuality(w, currentYear());
    recordQuality(quality, report);
    if (report.keep) passed.push(w);
  }

  const deduped = dedupe(passed).kept;

  /**
   * 池子上限。
   *
   * 候选对的生成是 O(n²) 的局部计算(不花钱但吃 CPU),而且池子越大,
   * 判定候选的排序也越容易把真正重要的那几条挤下去。
   * 种子无论如何保留 —— 它们是整张图的圆心。
   */
  const poolCap = Math.max(20, Math.min(400, opts.budget ?? 160));
  const poolPapers = applyBudget(deduped, poolCap, new Set(allSeedIds));
  const poolById = new Map(poolPapers.map((w) => [w.id, w]));

  const core = selectCore(neighborhoods, poolById);
  const previous = previousStateFrom(existing);

  // ---------- 第一层:结构骨架 ----------
  let papers = core;
  let built = buildGraph(papers, allSeedIds, {
    anchorPaperId: seedOaId,
    previous: previous
      ? {
          layout: pickAnchors(previous.layout, papers),
          communityOf: pickAnchors(previous.communityOf, papers),
        }
      : undefined,
  });

  const seedWork = core.find((w) => w.id === seedOaId);
  const starfield: Starfield = {
    id: existing?.starfield.id ?? starfieldId(allSeedIds),
    name: opts.name ?? existing?.starfield.name ?? seedWork?.title ?? "未命名星空",
    ownerId: "local",
    seeds: existing?.starfield.seeds ?? [],
    createdAt: existing?.starfield.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewport: existing?.starfield.viewport ?? { x: 0, y: 0, scale: 1 },
    stats: statsOf(built.graph),
  };

  yield {
    type: "structure",
    starfield,
    graph: built.graph,
    layout: built.layout,
    presets,
  };

  // ---------- 逐层扩展 ----------
  const centers = new Set<string>([...allSeedIds, ...core.map((w) => w.id)]);
  const judgedPairs = new Set<string>();
  const relations = emptyReport();

  /**
   * 实时视图:管道在后台判定,这里同步地把它长出来的东西整理成一张可渲染的图。
   *
   * 为什么"边判边推"要经过一个队列而不是直接 yield:
   * `buildSemanticEdges` 是普通异步函数,它的回调里没法 yield。
   * 所以回调只负责把事件塞进队列并唤醒生成器,由生成器在事件循环里吐出去。
   * 这样"流式"和"非流式"仍然是同一段判定代码,不会跑偏。
   */
  const live = {
    papers: [...papers],
    built,
    edges: [] as GraphEdge[],
    seen: new Set<string>(),
  };
  const queue: GrowEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const publish = (event: GrowEvent): void => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  const absorb = (batch: GraphEdge[]): void => {
    const fresh = new Set<string>();
    for (const e of batch) {
      if (!live.seen.has(e.id)) {
        live.seen.add(e.id);
        live.edges.push(e);
      }
      for (const id of [e.source, e.target]) {
        const oa = id.replace(/^paper:/, "");
        if (poolById.has(oa) && !live.papers.some((w) => w.id === oa)) fresh.add(oa);
      }
    }
    if (!fresh.size) return;

    live.papers = [
      ...live.papers,
      ...[...fresh].map((id) => poolById.get(id)).filter((w): w is OaWork => Boolean(w)),
    ];
    // 老节点的坐标作为锚点:新论文进来时,已有的星体只做微调
    live.built = buildGraph(live.papers, allSeedIds, {
      anchorPaperId: seedOaId,
      previous: { layout: live.built.layout, communityOf: communityOfGraph(live.built.graph) },
    });
    publish({
      type: "graph",
      graph: mergeSemanticEdges(live.built.graph, live.edges),
      layout: live.built.layout,
    });
  };

  for (let round = 1; round <= depth; round++) {
    finished = false;
    const running = buildSemanticEdges(poolPapers, {
      presets,
      seedOaIds: allSeedIds,
      centerOaIds: [...centers],
      skipPairs: judgedPairs,
      // 逐层收窄预算:第一层把主要关系找全,后续层只做补充
      maxJudgedPerPreset: round === 1 ? judgeDepth : Math.max(4, Math.round(judgeDepth / 2)),
      onEdges: absorb,
    }).then((r) => {
      finished = true;
      wake?.();
      wake = null;
      return r;
    });

    while (!finished || queue.length) {
      if (queue.length) {
        const next = queue.shift();
        if (next) yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    const { edges, report } = await running;
    sumReports(relations, report);

    // 记录本轮判过的对,下一轮不再重复送审
    for (const k of report.judgedPairs) judgedPairs.add(k);

    // 本轮新加入的论文成为下一轮的探索中心
    const added = new Set<string>();
    for (const e of edges) {
      for (const id of [e.source, e.target]) {
        const oa = id.replace(/^paper:/, "");
        if (poolById.has(oa)) added.add(oa);
      }
    }
    const before = centers.size;
    for (const id of added) centers.add(id);

    papers = live.papers;
    built = live.built;

    yield {
      type: "progress",
      round,
      depth,
      judged: Object.values(relations.perPreset).reduce((s, v) => s + v.judged, 0),
      matched: Object.values(relations.perPreset).reduce((s, v) => s + v.matched, 0),
      llmCalls: relations.llmCalls,
      estimatedTokens: relations.estimatedTokens,
    };

    // 这一轮没有发现新的中心,再往外也长不出东西了
    if (centers.size === before) break;
  }

  const allSemantic = live.edges;

  // ---------- 收尾 ----------
  /**
   * 最终布局重新算一次,不沿用流式过程中的中间态。
   *
   * 流式快照是**近似**的:每来一批判定就增量松弛一次,中间态会累积漂移
   * (实测表现为大部分星体挤在右侧、两颗被推到很远,整个包围盒被两个离群点撑大)。
   * 中间态用来"看着它长出来"没问题,但作为最终结果就不可接受了。
   *
   * 所以:新星空用完整的两阶段布局(最整齐);并入已有星空时用老坐标做锚点,
   * 兑现"老星体留在原地"的承诺。
   */
  built = buildGraph(papers, allSeedIds, {
    anchorPaperId: seedOaId,
    previous: previous
      ? {
          layout: pickAnchors(previous.layout, papers),
          communityOf: pickAnchors(previous.communityOf, papers),
        }
      : undefined,
  });

  const graph = mergeSemanticEdges(built.graph, allSemantic);
  const previousPaperCount = existing?.starfield.stats.papers ?? 0;
  const addedPapers = Math.max(0, graph.stats.papers - previousPaperCount);

  const seedEntry: SeedEntry = {
    query: workOf(papers, seedOaId)?.title ?? seedOaId,
    paperId: `paper:${seedOaId}`,
    addedAt: new Date().toISOString(),
    addedPapers,
  };

  const seeds = [...(existing?.starfield.seeds ?? []), seedEntry].filter(
    (s, i, arr) => arr.findIndex((x) => x.paperId === s.paperId) === i,
  );

  const finalStarfield: Starfield = {
    ...starfield,
    seeds,
    updatedAt: new Date().toISOString(),
    stats: statsOf(graph),
  };

  const meta: BuildMeta = {
    quality,
    relations,
    capabilities: await capabilityReport(),
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    addedPapers,
  };

  const payload: StarfieldPayload = {
    starfield: finalStarfield,
    graph,
    layout: built.layout,
    presets,
    meta,
  };

  await saveStarfield(payload);
  yield { type: "done", payload };
}

/** 消费事件流并返回最终载荷。非流式接口用它,保证与流式走同一段代码。 */
export async function growStarfield(opts: GrowOptions): Promise<StarfieldPayload> {
  let payload: StarfieldPayload | null = null;
  for await (const event of growStarfieldStream(opts)) {
    if (event.type === "done") payload = event.payload;
  }
  if (!payload) throw new Error("构建未产出结果");
  return payload;
}

export { growStarfieldStream };

/** 按给定论文集合裁剪锚点:被裁掉的节点不该继续影响布局。 */
function pickAnchors<T>(map: Record<string, T>, papers: OaWork[]): Record<string, T> {
  const keep = new Set(papers.map((w) => `paper:${w.id}`));
  return Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));
}

function communityOfGraph(graph: Graph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const edge of graph.edges) {
    if (edge.kind === "BELONGS_TO" && edge.source.startsWith("paper:")) {
      const idx = Number(edge.target.replace("community:", ""));
      if (Number.isFinite(idx)) out[edge.source] = idx;
    }
  }
  return out;
}

function statsOf(graph: Graph) {
  return {
    papers: graph.stats.papers,
    edges: graph.stats.edges,
    communities: graph.stats.communities,
    domains: graph.stats.domains,
  };
}

function workOf(papers: OaWork[], id: string): OaWork | undefined {
  return papers.find((w) => w.id === id);
}
