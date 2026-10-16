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
import { zhLabel } from "./field-labels";

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
  // OpenAlex 只给英文标签,而"研究前沿"是我们自己归纳的概念 ——
  // 用中文命名才是对的(论文标题则保留原文,翻译反而有害)。
  // 查不到的保留英文原名,而不是硬翻成半通不通的中文。
  return { zh: best ? zhLabel(best) : "未归类前沿" };
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
    labels = alignLabels(prevLabels, labels);
  }

  /**
   * 社区编号的**编号空间**与**社区数量**不是一回事。
   *
   * 对齐之后编号会出现空洞(例如这一轮只剩 0 号和 2 号社区,因为 1 号被合并掉了)。
   * 早期版本按「社区数量」去建成员数组,于是编号 2 直接越界被静默跳过 ——
   * 表现是社区少了一个、领域退化成「其他方向」,而日志里什么都不报。
   * 所以这里按「最大编号 + 1」建空间,空洞处天然为空,后续遍历跳过即可。
   */
  const labelSpace = labels.reduce((m, l) => Math.max(m, l), -1) + 1;

  // ---------- L3 派生层:布局 ----------
  const anchorIdx = anchorPaperId ? indexOf[anchorPaperId] : undefined;
  const anchorCommunity = anchorIdx === undefined ? 0 : (labels[anchorIdx] ?? 0);

  const seedState = previous ? relaxIntoAnchors(papers, undirected, previous, width, height) : null;

  const result =
    seedState ??
    layoutGraph(papers.length, undirected, labels, labelSpace, {
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
  const members: number[][] = Array.from({ length: labelSpace }, () => []);
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
    let best = "";
    let bestN = 0;
    for (const [name, n] of tally) {
      if (n > bestN) {
        best = name;
        bestN = n;
      }
    }

    /**
     * 回退链:field → subfield → 社区自己的标签。
     *
     * OpenAlex 的字段标注并不完整,总有一部分论文没有 field。
     * 早期版本在这里直接落到「未归类」,结果图上多出一朵什么都装的星云 ——
     * 它既不帮助理解,又占掉一个领域色的位置。用 subfield 兜一层之后,
     * 这些论文会归到最接近它们真实方向的那个领域里。
     */
    if (!best) {
      const subTally = new Map<string, number>();
      for (const i of idx) {
        const w = papers[i];
        const s = w?.fields.find((x) => x.level === "subfield");
        if (s) subTally.set(s.name, (subTally.get(s.name) ?? 0) + 1);
      }
      for (const [name, n] of subTally) {
        if (n > bestN) {
          best = name;
          bestN = n;
        }
      }
    }
    if (!best) best = communityNodes[c]?.label ?? "其他方向";

    const label = zhLabel(best);
    const list = domainOf.get(label);
    if (list) list.push(c);
    else domainOf.set(label, [c]);
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

  // 新节点的落点
  if (!Number.isFinite(knownMinX)) {
    knownMinX = width * 0.35;
    knownMaxX = width * 0.65;
    knownMinY = height * 0.35;
    knownMaxY = height * 0.65;
  }

  /**
   * 新节点落在**已有邻居的重心**旁边,而不是在已知区域里随机撒。
   *
   * 早期版本用随机撒点,结果是新论文一开始离自己的邻居很远:
   * 引力弹簧要把它们拉回来,斥力又要推开别的节点,两边打架,
   * 布局被撕成相距上万像素的几团。以邻居重心为起点之后,
   * 松弛只需要做微调 —— 这也是「位置是论文的持久属性」这条设计
   * 在增量路径上的具体兑现方式。
   */
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of edges) {
    const la = adjacency.get(a);
    if (la) la.push(b);
    else adjacency.set(a, [b]);
    const lb = adjacency.get(b);
    if (lb) lb.push(a);
    else adjacency.set(b, [a]);
  }

  // 已知区域的中心,用于完全没有旧邻居时的兜底
  const centerX = (knownMinX + knownMaxX) / 2;
  const centerY = (knownMinY + knownMaxY) / 2;
  const spread = Math.max(60, Math.min(knownMaxX - knownMinX, knownMaxY - knownMinY) * 0.08);

  let idx = 0;
  for (const a of anchors) {
    if (!a) {
      const p = positions[idx];
      if (p) {
        const neighbors = adjacency.get(idx) ?? [];
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (const j of neighbors) {
          const anchor = anchors[j];
          if (!anchor) continue;
          sx += anchor.x;
          sy += anchor.y;
          n++;
        }
        if (n > 0) {
          p.x = sx / n + (rnd() - 0.5) * spread;
          p.y = sy / n + (rnd() - 0.5) * spread;
        } else {
          // 完全没有已就位的邻居:放在已知区域中心附近,让松弛自己把它带走
          p.x = centerX + (rnd() - 0.5) * spread * 2;
          p.y = centerY + (rnd() - 0.5) * spread * 2;
        }
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
