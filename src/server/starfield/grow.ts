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

import { capabilityReport } from "../config";
import { cached } from "../cache";
import { buildGraph, dedupe, type PreviousState } from "../graph/build";
import { buildSemanticEdges } from "../relations/pipeline";
import { BUILTIN_PRESETS } from "../relations/presets";
import { getCitingWorks, getWorkById, getWorksByIds, type OaWork } from "../sources/openalex";
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
  });
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
  /** 每类关系送审多少对候选 —— 直接决定模型成本与图的稠密程度 */
  judgeDepth?: number;
  /** 用户在设置页改写过的关系预设;缺省时用内置的那一份 */
  presets?: RelationPreset[];
}

/**
 * 让星空长大。
 *
 * 已有星空:并入新种子,增量构建。
 * 新星空:从零构建。
 */
export async function growStarfield(opts: GrowOptions): Promise<StarfieldPayload> {
  const started = Date.now();
  const poolSize = Math.max(6, Math.min(200, opts.pool ?? DEFAULT_POOL));
  const seedOaId = opts.seedPaperId.replace(/^paper:/, "");
  const presets: RelationPreset[] = opts.presets?.length ? opts.presets : BUILTIN_PRESETS;

  const existing = opts.starfieldId ? await loadStarfield(opts.starfieldId) : null;

  // 既有星空里的所有种子都要在场 —— 累积构建的前提
  const allSeedIds = [
    ...new Set([...(existing?.starfield.seeds.map((s) => s.paperId.replace(/^paper:/, "")) ?? []), seedOaId]),
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

  // ---------- 去重 ----------
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

  /**
   * 入图的是**结构核 ∪ 语义命中**,而不是整个邻域。
   *
   * 这是这次改造的核心:引文层退到"骨架"的位置(每个种子前后各三篇),
   * 图上的其余论文必须靠一条被确认的关系挣得位置。
   * 直接后果是画面上每一颗星都有理由在那儿,而不再是一大片"看起来相关"的散点。
   */
  const poolById = new Map(poolPapers.map((w) => [w.id, w]));
  const core = selectCore(neighborhoods, poolById);

  /**
   * 判定的**中心**不只是种子,而是整个结构核。
   *
   * 只从种子向外找,图最多长到"种子 + 一圈"就停了 —— 实测 14 篇。
   * 把结构核(种子的前后各三篇)一起当作中心之后,探索前沿变成了整个骨架,
   * 语义关系才能一层层往外长。这也是"主体放在语义层"能否成立的关键:
   * 引文层给出**从哪儿开始看**,语义层决定**能看到多远**。
   */
  const centers = [...new Set([...allSeedIds, ...core.map((w) => w.id)])];

  // ---------- 语义关系(在候选池上判定,而不是在入图集合上) ----------
  const { edges: semantic, report: relations } = await buildSemanticEdges(poolPapers, {
    presets,
    seedOaIds: allSeedIds,
    centerOaIds: centers,
    maxJudgedPerPreset: Math.max(4, Math.min(40, opts.judgeDepth ?? DEFAULT_JUDGE_DEPTH)),
  });

  const matchedIds = new Set<string>();
  for (const e of semantic) {
    matchedIds.add(e.source.replace(/^paper:/, ""));
    matchedIds.add(e.target.replace(/^paper:/, ""));
  }

  const keepIds = new Set<string>([...core.map((w) => w.id), ...matchedIds]);
  const papers = poolPapers.filter((w) => keepIds.has(w.id));
  const finalIds = new Set(papers.map((w) => w.id));

  // 只保留两端都在图里的语义边
  const keptSemantic = semantic.filter(
    (e) =>
      finalIds.has(e.source.replace(/^paper:/, "")) && finalIds.has(e.target.replace(/^paper:/, "")),
  );

  // ---------- 建图 ----------
  const previous = previousStateFrom(existing);
  const built = buildGraph(papers, allSeedIds, {
    anchorPaperId: seedOaId,
    previous: previous
      ? {
          // 只保留仍然在场的节点的锚点:被预算裁掉的节点不该继续影响布局
          layout: Object.fromEntries(
            Object.entries(previous.layout).filter(([k]) => finalIds.has(k.replace(/^paper:/, ""))),
          ),
          communityOf: Object.fromEntries(
            Object.entries(previous.communityOf).filter(([k]) =>
              finalIds.has(k.replace(/^paper:/, "")),
            ),
          ),
        }
      : undefined,
  });

  const graph = mergeSemanticEdges(built.graph, keptSemantic);

  // ---------- 星空元信息 ----------
  const seedWork = papers.find((w) => w.id === seedOaId);
  const previousPaperCount = existing?.starfield.stats.papers ?? 0;

  const seedEntry: SeedEntry = {
    query: existing ? (seedWork?.title ?? seedOaId) : (seedWork?.title ?? seedOaId),
    paperId: `paper:${seedOaId}`,
    addedAt: new Date().toISOString(),
    addedPapers: Math.max(0, graph.stats.papers - previousPaperCount),
  };

  const seeds = [...(existing?.starfield.seeds ?? []), seedEntry].filter(
    (s, i, arr) => arr.findIndex((x) => x.paperId === s.paperId) === i,
  );

  const starfield: Starfield = {
    id: existing?.starfield.id ?? starfieldId(allSeedIds),
    name: opts.name ?? existing?.starfield.name ?? seedWork?.title ?? "未命名星空",
    ownerId: "local",
    seeds,
    createdAt: existing?.starfield.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    viewport: existing?.starfield.viewport ?? { x: 0, y: 0, scale: 1 },
    stats: {
      papers: graph.stats.papers,
      edges: graph.stats.edges,
      communities: graph.stats.communities,
      domains: graph.stats.domains,
    },
  };

  const meta: BuildMeta = {
    quality,
    relations,
    capabilities: capabilityReport(),
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    addedPapers: seedEntry.addedPapers,
  };

  const payload: StarfieldPayload = {
    starfield,
    graph,
    layout: built.layout,
    presets,
    meta,
  };

  await saveStarfield(payload);
  return payload;
}
