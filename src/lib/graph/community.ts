/**
 * 社区检测 —— 标签传播 + 模块度择优。
 *
 * 为什么不用裸标签传播:它在引文这种稀疏、无标度的图上容易塌成一个巨无霸社区。
 * 做法是带权图 + 多次随机重启,取**模块度最高**的那次划分;
 * 最后把小社区并入连接最强的邻居,避免图上一堆孤星。
 *
 * 本文件是纯函数:没有 IO、没有 React、没有全局状态,可以脱离服务端跑单测。
 */

import { mulberry32 } from "./rng";

export interface WeightedEdge {
  a: number;
  b: number;
  /** 权重:引文关系为 1,语义相近额外加权 */
  w: number;
}

export interface CommunityResult {
  /** 每个节点的社区编号,已按社区规模降序重编号(0 号最大) */
  labels: number[];
  sizes: number[];
  modularity: number;
}

type Adj = Array<Array<{ to: number; w: number }>>;

function buildAdj(n: number, edges: WeightedEdge[]): Adj {
  const adj: Adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.a === e.b) continue;
    adj[e.a]?.push({ to: e.b, w: e.w });
    adj[e.b]?.push({ to: e.a, w: e.w });
  }
  return adj;
}

/** 加权模块度 Q。 */
export function modularity(n: number, adj: Adj, labels: number[]): number {
  const deg = new Float64Array(n);
  let m2 = 0;
  for (let v = 0; v < n; v++) {
    let d = 0;
    for (const e of adj[v] ?? []) d += e.w;
    deg[v] = d;
    m2 += d;
  }
  if (m2 <= 0) return 0;

  const commDeg = new Map<number, number>();
  const commIn = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const lv = labels[v] ?? 0;
    commDeg.set(lv, (commDeg.get(lv) ?? 0) + (deg[v] ?? 0));
    for (const e of adj[v] ?? []) {
      if (labels[e.to] === lv) commIn.set(lv, (commIn.get(lv) ?? 0) + e.w);
    }
  }

  let q = 0;
  for (const [c, d] of commDeg) {
    q += (commIn.get(c) ?? 0) / m2 - (d / m2) ** 2;
  }
  return q;
}

function labelPropagation(n: number, adj: Adj, rnd: () => number, maxIter = 30): number[] {
  const labels = Array.from({ length: n }, (_, i) => i);
  const order = Array.from({ length: n }, (_, i) => i);

  for (let iter = 0; iter < maxIter; iter++) {
    // 异步更新:每次迭代打乱顺序,避免振荡
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const a = order[i];
      const b = order[j];
      if (a === undefined || b === undefined) continue;
      order[i] = b;
      order[j] = a;
    }

    let changed = 0;
    for (const v of order) {
      const score = new Map<number, number>();
      for (const e of adj[v] ?? []) {
        const l = labels[e.to] ?? 0;
        score.set(l, (score.get(l) ?? 0) + e.w);
      }
      if (!score.size) continue;

      let best = -Infinity;
      const tied: number[] = [];
      for (const [l, s] of score) {
        if (s > best) {
          best = s;
          tied.length = 0;
          tied.push(l);
        } else if (s === best) {
          tied.push(l);
        }
      }

      /**
       * 平局处理决定了死活。
       *
       * 最初平局时选「编号最小」的标签,标签会像传染病一样扩散,
       * 整张图最终塌成一个社区 —— 实测模块度直接归零。
       * 正确做法是「保持自身标签」的惯性 + 随机打破平局。
       */
      const self = labels[v] ?? 0;
      const next = tied.includes(self)
        ? self
        : tied.length === 1
          ? (tied[0] ?? self)
          : (tied[Math.floor(rnd() * tied.length)] ?? self);

      if (next !== self) {
        labels[v] = next;
        changed++;
      }
    }
    if (!changed) break;
  }

  return labels;
}

/** 按规模降序重编号,并把过小的社区并入连接最强的邻居。 */
function tidy(
  n: number,
  adj: Adj,
  raw: number[],
  minSize: number,
): { labels: number[]; sizes: number[] } {
  const count = new Map<number, number>();
  for (const l of raw) count.set(l, (count.get(l) ?? 0) + 1);

  const labels = raw.slice();
  for (let v = 0; v < n; v++) {
    const self = labels[v] ?? 0;
    if ((count.get(self) ?? 0) >= minSize) continue;

    const weight = new Map<number, number>();
    for (const e of adj[v] ?? []) {
      const l = labels[e.to] ?? 0;
      weight.set(l, (weight.get(l) ?? 0) + e.w);
    }

    let best = self;
    let bestW = -1;
    for (const [l, w] of weight) {
      if (l === self) continue;
      if ((count.get(l) ?? 0) < minSize) continue;
      if (w > bestW) {
        best = l;
        bestW = w;
      }
    }
    if (bestW > 0) {
      count.set(self, (count.get(self) ?? 0) - 1);
      labels[v] = best;
      count.set(best, (count.get(best) ?? 0) + 1);
    }
  }

  const sizes = new Map<number, number>();
  for (const l of labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);

  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const remap = new Map<number, number>();
  ranked.forEach((l, i) => remap.set(l, i));

  return {
    labels: labels.map((l) => remap.get(l) ?? 0),
    sizes: ranked.map((l) => sizes.get(l) ?? 0),
  };
}

export function detectCommunities(
  nodeCount: number,
  edges: WeightedEdge[],
  opts: { seed?: number; restarts?: number; minSize?: number } = {},
): CommunityResult {
  const { seed = 20_261_015, restarts = 10, minSize = 4 } = opts;
  const adj = buildAdj(nodeCount, edges);

  let bestLabels: number[] | null = null;
  let bestQ = -Infinity;
  for (let r = 0; r < restarts; r++) {
    const labels = labelPropagation(nodeCount, adj, mulberry32(seed + r * 7919));
    const q = modularity(nodeCount, adj, labels);
    if (q > bestQ) {
      bestQ = q;
      bestLabels = labels;
    }
  }
  if (!bestLabels) bestLabels = Array.from({ length: nodeCount }, (_, i) => i);

  const { labels, sizes } = tidy(nodeCount, adj, bestLabels, minSize);
  return { labels, sizes, modularity: modularity(nodeCount, adj, labels) };
}

/**
 * 把新社区的编号对齐到旧编号。
 *
 * 增量构建时每次都要重聚类(只按邻居多数票归属会让新论文全挤进一个既存社区,
 * 实测某个社区从 97 篇涨到 367 篇,图直接糊成一团)。
 * 但重聚类会打乱编号,所以按「新旧社区的重叠票数」做最大匹配:
 * 重叠最多的沿用老编号,没有对应老社区的新社区才分配全新编号。
 */
export function alignLabels(previous: number[], next: number[]): number[] {
  const overlap = new Map<string, number>();
  const nextSizes = new Map<number, number>();

  for (let i = 0; i < next.length; i++) {
    const oldL = previous[i];
    const newL = next[i];
    if (oldL === undefined || newL === undefined) continue;
    const k = `${newL}|${oldL}`;
    overlap.set(k, (overlap.get(k) ?? 0) + 1);
    nextSizes.set(newL, (nextSizes.get(newL) ?? 0) + 1);
  }

  // 贪心最大匹配:每次取全局剩余票数最多的一对
  const entries = [...overlap.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map<number, number>();
  const usedOld = new Set<number>();

  for (const [k, votes] of entries) {
    const [newL, oldL] = k.split("|").map(Number);
    if (newL === undefined || oldL === undefined) continue;
    if (map.has(newL) || usedOld.has(oldL)) continue;
    const size = nextSizes.get(newL) ?? 0;
    // 至少要拿到该社区三成票,才认为它是老社区的后代
    if (size > 0 && votes / size >= 0.3) {
      map.set(newL, oldL);
      usedOld.add(oldL);
    }
  }

  let fresh = 0;
  while (usedOld.has(fresh)) fresh++;

  const maxOld = previous.reduce((m, l) => Math.max(m, l), -1);
  let nextFresh = Math.max(fresh, maxOld + 1);

  return next.map((l) => {
    const mapped = map.get(l);
    if (mapped !== undefined) return mapped;
    map.set(l, nextFresh);
    usedOld.add(nextFresh);
    nextFresh++;
    return nextFresh - 1;
  });
}
