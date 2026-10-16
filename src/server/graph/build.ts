/**
 * 从原始论文记录构建图谱。
 *
 * 这个文件负责的正是知识图谱模型的 L1 结构层与 L3 派生层:
 *   L1  引用边、作者、发表、提及 —— 全部来自上游,不加工事实
 *   L3  社区、领域 —— 算法算出来,给定同样输入必然复现
 *
 * L2 语义层不在这里:那需要大模型,由 relations/ 负责,最后合并进同一张图。
 */

import { alignLabels, detectCommunities, type WeightedEdge } from "@/lib/graph/community";
import {
  layoutGraph,
  normalizeDensity,
  relaxWithAnchors,
  type ClusterPlacement,
} from "@/lib/graph/layout";
import { hashSeed, mulberry32 } from "@/lib/graph/rng";
import type {
  CommunityNode,
  DomainNode,
  Graph,
  GraphEdge,
  GraphLayout,
  NodeId,
  PaperNode,
  Provenance,
  Vec2,
} from "@/types/kg";

import type { OaWork } from "../sources/openalex";

/** 世界尺寸。布局由内容决定,世界只是给相机一个初始范围。 */
export const WORLD_WIDTH = 2600;
export const WORLD_HEIGHT = 1800;

export interface PreviousState {
  /** 节点 id → 老坐标。增量构建时作为锚点。 */
  layout: GraphLayout;
  /** 节点 id → 老社区编号。用于重聚类后的编号对齐。 */
  communityOf: Record<string, number>;
}

export interface BuildOutput {
  graph: Graph;
  layout: GraphLayout;
  clusters: ClusterPlacement[];
  /** 节点 id → 下标,布局与边都按下标算,输出时再翻译回 id */
  indexOf: Record<string, number>;
}

const now = (): string => new Date().toISOString();

const oaProvenance = (ref: string): Provenance => ({
  source: "openalex",
  ref,
  at: now(),
});

const algoProvenance = (ref: string): Provenance => ({
  source: "algorithm",
  ref,
  at: now(),
});

/** 归一化标题,用于识别同一篇论文的多条记录。 */
const normTitle = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 去重。
 *
 * 实测:同一篇论文在 OpenAlex 里可能有多条记录(NumPy 那篇出现过两次)。
 * 而重复记录的破坏力被严重低估 —— 实测它能让整张图的模块度掉一个数量级
 * (0.2369 → 0.0192,等于社区结构完全消失)。
 */
export function dedupe(papers: OaWork[]): { kept: OaWork[]; dropped: number } {
  const byId = new Map<string, OaWork>();
  const byTitle = new Map<string, string>();
  let dropped = 0;

  for (const w of papers) {
    if (byId.has(w.id)) {
      dropped++;
      continue;
    }
    const t = normTitle(w.title);
    const seen = t ? byTitle.get(t) : undefined;
    if (seen) {
      // 同标题重复记录:保留被引量更高的那条
      const existing = byId.get(seen);
      if (existing && existing.citedByCount >= w.citedByCount) {
        dropped++;
        continue;
      }
      if (existing) {
        byId.delete(seen);
        byId.set(w.id, w);
      }
      dropped++;
      continue;
    }
    byId.set(w.id, w);
    if (t) byTitle.set(t, w.id);
  }

  return { kept: [...byId.values()], dropped };
}

function toPaperNode(w: OaWork): PaperNode {
  return {
    kind: "paper",
    id: `paper:${w.id}`,
    title: w.title,
    abstract: w.abstract,
    year: w.year,
    venue: w.venue,
    citations: w.citedByCount,
    doi: w.doi,
    urls: w.doi ? { landing: w.doi.startsWith("http") ? w.doi : `https://doi.org/${w.doi}` } : {},
    authors: w.authors.slice(0, 8).map((a) => ({
      name: a.name,
      id: a.id ? `author:${a.id}` : undefined,
      institution: a.institution,
    })),
    fields: w.fields,
    provenance: oaProvenance(w.id),
  };
}

/** 社区标签取自成员里出现最多的子领域名 —— 比编号或者随机词可读得多。 */
function labelForCommunity(members: number[], papers: OaWork[]): { zh: string; en?: string } {
  const tally = new Map<string, number>();
  for (const i of members) {
    const w = papers[i];
    if (!w) continue;
    const sub = w.fields.find((f) => f.level === "subfield");
    if (sub) tally.set(sub.name, (tally.get(sub.name) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [name, n] of tally) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  // OpenAlex 的字段名是英文;界面需要中文标签时由前端做映射,
  // 这里只保证「有且稳定」——没有足够证据时退回最靠前的主题词。
  return { zh: best || "未归类前沿" };
}

export interface BuildOptions {
  width?: number;
  height?: number;
  anchorPaperId?: string;
  previous?: PreviousState;
}

export function buildGraph(
  input: OaWork[],
  seedOaIds: string[],
  opts: BuildOptions = {},
): BuildOutput {
  const { width = WORLD_WIDTH, height = WORLD_HEIGHT, anchorPaperId, previous } = opts;

  const papers = input;
  const indexOf: Record<string, number> = {};
  papers.forEach((w, i) => (indexOf[w.id] = i));

  // ---------- L1 结构层:引用边 ----------
  const citationPairs: Array<[number, number]> = [];
  const edges: GraphEdge[] = [];

  for (let i = 0; i < papers.length; i++) {
    const w = papers[i];
    if (!w) continue;
    for (const target of w.referencedWorks) {
      const j = indexOf[target];
      if (j === undefined || j === i) continue;
      citationPairs.push([i, j]);
      edges.push({
        id: `paper:${w.id}|CITES|paper:${target}`,
        kind: "CITES",
        layer: "structural",
        source: `paper:${w.id}`,
        target: `paper:${target}`,
        directed: true,
        weight: 1,
        confidence: 1,
        evidence: [{ kind: "citation", paperId: `paper:${w.id}`, cites: `paper:${target}` }],
        provenance: oaProvenance(`${w.id}->${target}`),
      });
    }
  }

  /**
   * 一句重要的自我提醒:引用图是**有向**的,但社区检测与布局需要无向连通性。
   * 这里刻意不把两种语义混进同一个结构 —— 边表保持有向,算法输入单独构造。
   */
  const undirected: Array<[number, number]> = citationPairs.map(([a, b]) => [a, b]);

  // ---------- L3 派生层:社区 ----------
  const weighted: WeightedEdge[] = undirected.map(([a, b]) => ({ a, b, w: 1 }));
  const community = detectCommunities(papers.length, weighted, {
    seed: hashSeed(seedOaIds.join("_")) || 20_261_015,
  });

  /**
   * 增量构建时先做编号对齐,老论文尽量留在原来的社区里。
   * 不做这一步的话,每加一篇种子整张图的社区编号都会洗牌,星云颜色跟着乱跳。
   */
  let labels = community.labels;
  if (previous) {
    const prevLabels = papers.map((w) => previous.communityOf[`paper:${w.id}`] ?? -1);
    const aligned = alignLabels(
      prevLabels.map((l) => (l < 0 ? -1 : l)),
      labels,
    );
    labels = aligned;
  }

  // ---------- L3 派生层:布局 ----------
  const anchorIdx = anchorPaperId ? indexOf[anchorPaperId] : undefined;
  const anchorCommunity = anchorIdx === undefined ? 0 : (labels[anchorIdx] ?? 0);

  const seedState = previous ? relaxIntoAnchors(papers, undirected, previous, width, height) : null;

  const result =
    seedState ??
    layoutGraph(papers.length, undirected, labels, community.sizes.length, {
      width,
      height,
      seed: hashSeed(seedOaIds.join("_")) || 20_261_015,
      anchorCommunity,
    });

  normalizeDensity(result.positions);

  const layout: GraphLayout = {};
  papers.forEach((w, i) => {
    const p = result.positions[i];
    if (p) layout[`paper:${w.id}`] = p;
  });

  // ---------- 社区节点 ----------
  const members: number[][] = Array.from({ length: community.sizes.length }, () => []);
  papers.forEach((_, i) => {
    const l = labels[i] ?? 0;
    members[l]?.push(i);
  });

  const communityNodes: CommunityNode[] = [];
  papers.forEach((w, i) => {
    const l = labels[i] ?? 0;
    edges.push({
      id: `paper:${w.id}|BELONGS_TO|community:${l}`,
      kind: "BELONGS_TO",
      layer: "derived",
      source: `paper:${w.id}`,
      target: `community:${l}`,
      directed: true,
      weight: 1,
      confidence: 1,
      evidence: [],
      provenance: algoProvenance("label-propagation"),
    });
  });

  members.forEach((idx, c) => {
    if (!idx.length) return;
    const memberWorks = idx.map((i) => papers[i]).filter((w): w is OaWork => Boolean(w));
    const years = memberWorks.map((w) => w.year).filter((y) => y > 0).sort((a, b) => a - b);
    const label = labelForCommunity(idx, papers);

    // 子图模块度:这个「前沿」到底是不是真的独立,而不是算法硬切出来的
    const inSet = new Set(idx);
    const innerEdges = undirected.filter(([a, b]) => inSet.has(a) && inSet.has(b));
    const subQ = innerEdges.length / Math.max(1, memberWorks.length);

    communityNodes.push({
      kind: "community",
      id: `community:${c}`,
      label: label.zh,
      labelEn: label.en,
      level: 0,
      parent: null,
      paperIds: idx.map((i) => `paper:${papers[i]?.id ?? ""}`),
      medianYear: years.length ? (years[Math.floor(years.length / 2)] ?? 0) : 0,
      modularity: subQ,
      tone: c,
      provenance: algoProvenance("label-propagation"),
    });
  });

  // ---------- 领域节点:把社区按主导子领域归并 ----------
  const domainOf = new Map<string, number[]>();
  members.forEach((idx, c) => {
    const tally = new Map<string, number>();
    for (const i of idx) {
      const w = papers[i];
      const f = w?.fields.find((x) => x.level === "field");
      if (f) tally.set(f.name, (tally.get(f.name) ?? 0) + 1);
    }
    let best = "未归类";
    let bestN = 0;
    for (const [name, n] of tally) {
      if (n > bestN) {
        best = name;
        bestN = n;
      }
    }
    const list = domainOf.get(best);
    if (list) list.push(c);
    else domainOf.set(best, [c]);
  });

  const domainNodes: DomainNode[] = [];
  let domainIdx = 0;
  for (const [name, communityIds] of domainOf) {
    const id = `domain:${domainIdx}`;
    const paperCount = communityIds.reduce((s, c) => s + (members[c]?.length ?? 0), 0);
    domainNodes.push({
      kind: "domain",
      id,
      label: name,
      memberCommunityIds: communityIds.map((c) => `community:${c}`),
      paperCount,
      tone: domainIdx,
      provenance: algoProvenance("field-grouping"),
    });
    for (const c of communityIds) {
      edges.push({
        id: `community:${c}|PART_OF|${id}`,
        kind: "PART_OF",
        layer: "derived",
        source: `community:${c}`,
        target: id,
        directed: true,
        weight: 1,
        confidence: 1,
        evidence: [],
        provenance: algoProvenance("field-grouping"),
      });
    }
    domainIdx++;
  }

  const nodes = [
    ...papers.map(toPaperNode),
    ...communityNodes,
    ...domainNodes,
  ];

  const byLayer = { structural: 0, semantic: 0, derived: 0 };
  for (const e of edges) byLayer[e.layer]++;

  return {
    graph: {
      nodes,
      edges,
      stats: {
        papers: papers.length,
        edges: edges.length,
        communities: communityNodes.length,
        domains: domainNodes.length,
        byLayer,
      },
    },
    layout,
    clusters: result.clusters,
    indexOf,
  };
}

/**
 * 增量布局:老节点作为锚点被拉回原位,新节点自由松弛。
 *
 * 世界原点固定在中心,世界只做**对称长大** —— 这一点是硬约束。
 * 曾经把内容重新居中到世界盒子,结果世界一变大,所有老星体的坐标被整体平移,
 * 实测中位位移 321px,用户看到的就是「我一搜,原来的星图就没了」。
 */
function relaxIntoAnchors(
  papers: OaWork[],
  edges: Array<[number, number]>,
  previous: PreviousState,
  width: number,
  height: number,
): { positions: Vec2[]; clusters: ClusterPlacement[] } {
  const rnd = mulberry32(hashSeed(papers.map((w) => w.id).join("_")));
  const positions: Vec2[] = [];
  const anchors: Array<Vec2 | null> = [];

  let knownMinX = Infinity;
  let knownMaxX = -Infinity;
  let knownMinY = Infinity;
  let knownMaxY = -Infinity;

  for (const w of papers) {
    const old = previous.layout[`paper:${w.id}`];
    if (old) {
      positions.push({ x: old.x, y: old.y });
      anchors.push({ x: old.x, y: old.y });
      knownMinX = Math.min(knownMinX, old.x);
      knownMaxX = Math.max(knownMaxX, old.x);
      knownMinY = Math.min(knownMinY, old.y);
      knownMaxY = Math.max(knownMaxY, old.y);
    } else {
      // 新节点先插到世界中心附近:后续松弛会把它拉到邻居的重心旁边
      positions.push({ x: 0, y: 0 });
      anchors.push(null);
    }
  }

  // 新节点从已知区域的随机位置起步,避免全部叠在原点
  if (!Number.isFinite(knownMinX)) {
    knownMinX = width * 0.35;
    knownMaxX = width * 0.65;
    knownMinY = height * 0.35;
    knownMaxY = height * 0.65;
  }
  let idx = 0;
  for (const a of anchors) {
    if (!a) {
      const p = positions[idx];
      if (p) {
        p.x = knownMinX + rnd() * (knownMaxX - knownMinX);
        p.y = knownMinY + rnd() * (knownMaxY - knownMinY);
      }
    }
    idx++;
  }

  relaxWithAnchors(papers.length, edges, positions, anchors);

  const clusters: ClusterPlacement[] = [];
  return { positions, clusters };
}

export function isNodeId(v: string): v is NodeId {
  return typeof v === "string" && v.includes(":");
}
