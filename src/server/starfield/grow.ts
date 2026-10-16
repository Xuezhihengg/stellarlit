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

/** 单次构建的默认论文预算。超过这个量级,canvas 的可读性会先于性能崩掉。 */
export const DEFAULT_BUDGET = 220;
/** 向后 / 向前各取多少篇。 */
const BACKWARD_LIMIT = 140;
const FORWARD_LIMIT = 140;

const currentYear = () => new Date().getFullYear();

/**
 * 展开一篇种子的引文邻域,并按种子缓存。
 *
 * 为什么按种子缓存而不是按星空缓存:同一篇论文出现在两片星空里时,
 * 上游数据完全相同,缓存可以复用。
 */
async function neighborhoodOf(seedId: string): Promise<OaWork[]> {
  return cached("neighborhood", seedId, async () => {
    const seed = await getWorkById(seedId);
    if (!seed) return [];

    // 向后:它引用了谁(取它自己记录的 references)
    const backwardIds = seed.referencedWorks.slice(0, BACKWARD_LIMIT);
    const backward = backwardIds.length ? await getWorksByIds(backwardIds) : [];

    // 向前:谁引用了它。按被引量降序 —— 高被引的引用者才是主干。
    let forward: OaWork[] = [];
    try {
      forward = await getCitingWorks(seedId, FORWARD_LIMIT);
    } catch {
      // 向前引用失败不应该让整次构建失败:向后邻域本身已经能构成一张合法的星图
      forward = [];
    }

    return [seed, ...backward, ...forward];
  });
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
  budget?: number;
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
  const budget = Math.max(40, Math.min(600, opts.budget ?? DEFAULT_BUDGET));
  const seedOaId = opts.seedPaperId.replace(/^paper:/, "");
  const presets: RelationPreset[] = opts.presets?.length ? opts.presets : BUILTIN_PRESETS;

  const existing = opts.starfieldId ? await loadStarfield(opts.starfieldId) : null;

  // 既有星空里的所有种子都要在场 —— 累积构建的前提
  const allSeedIds = [
    ...new Set([...(existing?.starfield.seeds.map((s) => s.paperId.replace(/^paper:/, "")) ?? []), seedOaId]),
  ];

  const merged = new Map<string, OaWork>();
  for (const id of allSeedIds) {
    for (const w of await neighborhoodOf(id)) {
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

  const mustKeep = new Set(allSeedIds);
  const papers = applyBudget(deduped, budget, mustKeep);
  const finalIds = new Set(papers.map((w) => w.id));

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

  // ---------- 语义关系 ----------
  const { edges: semantic, report: relations } = await buildSemanticEdges(papers, {
    presets,
    seedOaIds: allSeedIds,
  });

  const graph = mergeSemanticEdges(built.graph, semantic);

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
