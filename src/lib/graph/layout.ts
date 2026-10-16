/**
 * 布局 —— 前端不做力导向,主线程才守得住 60fps。
 *
 * 两阶段:
 *   1. 社区内部:力导向(斥力 + 引力弹簧 + 向心约束),把成员摊在各自的圆盘里
 *   2. 社区之间:把圆盘当成刚体排布,跨社区引用多的靠近,种子所在社区钉在正中
 *
 * 这个「团中有团」的结构正是星图要的:近看是论文,远看是领域。
 *
 * 性能:内部斥力用均匀网格加速(只与邻近格子作用),复杂度从 O(n²) 降到约 O(n·k)。
 * 本文件是纯函数,可脱离服务端与浏览器运行。
 */

import type { Vec2 } from "@/types/kg";

import { mulberry32 } from "./rng";

/**
 * 星体的目标间距。
 *
 * 取自冻结视觉稿的实测密度:22 篇的社区 r=172 → 约 4225 px²/节点 → 等效间距约 64px。
 * 真实数据必须对齐到这个密度,否则「星图」看起来就是一团糊。
 */
export const TARGET_SPACING = 64;

export interface ClusterPlacement {
  cx: number;
  cy: number;
  r: number;
  /** 成员数 */
  n: number;
}

export interface LayoutResult {
  positions: Vec2[];
  clusters: ClusterPlacement[];
}

export interface LayoutOptions {
  width: number;
  height: number;
  seed?: number;
  /** 钉在世界中心的社区(通常是种子论文所在的社区) */
  anchorCommunity?: number;
}

/** 网格加速的斥力:每个点只与 3×3 邻格内的点相互作用。 */
export function repulsion(
  pos: Vec2[],
  idx: number[],
  cell: number,
  strength: number,
  maxR: number,
): void {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  for (const i of idx) {
    const p = pos[i];
    if (!p) continue;
    const k = key(p.x, p.y);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  for (const i of idx) {
    const pi = pos[i];
    if (!pi) continue;
    const gx = Math.floor(pi.x / cell);
    const gy = Math.floor(pi.y / cell);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const pj = pos[j];
          if (!pj) continue;

          let vx = pi.x - pj.x;
          let vy = pi.y - pj.y;
          let d2 = vx * vx + vy * vy;
          if (d2 > maxR * maxR) continue;
          if (d2 < 0.01) {
            vx = 0.1;
            vy = 0.1;
            d2 = 0.02;
          }

          /**
           * 单次迭代的位移上限。
           *
           * 斥力是 strength/d²,两个几乎重合的节点(d²≈0.02)会得到约 1500px 的位移 ——
           * 一次迭代就把整个布局炸开。实测增量构建时坐标范围因此被拉到 1.6 万像素,
           * 而整图的最近邻间距仍是正常的 64px,所以密度归一化也救不回来。
           * 夹住上限之后,重合只会在几十次迭代里被缓慢推开,布局始终收敛。
           */
          const f = Math.min(strength / d2, MAX_STEP);
          const d = Math.sqrt(d2);
          const fx = (vx / d) * f;
          const fy = (vy / d) * f;
          pi.x += fx;
          pi.y += fy;
          pj.x -= fx;
          pj.y -= fy;
        }
      }
    }
  }
}

/** 斥力在单次迭代内允许产生的最大位移(世界坐标像素)。 */
const MAX_STEP = 6;

export function layoutGraph(
  nodeCount: number,
  edges: Array<[number, number]>,
  labels: number[],
  communityCount: number,
  opts: LayoutOptions,
): LayoutResult {
  const { width, height, seed = 20_261_015, anchorCommunity = 0 } = opts;
  const rnd = mulberry32(seed);

  const members: number[][] = Array.from({ length: communityCount }, () => []);
  for (let i = 0; i < nodeCount; i++) members[labels[i] ?? 0]?.push(i);

  /**
   * 社区半径由目标密度**算出来**,不拍脑袋。
   *
   *   R = √(n · spacing² / π) × 1.15
   *
   * 这样「每个社区占多大」和「星体间距多大」是同一个决定的两面:
   * 密度对齐了设计,社区尺寸也就自动对齐了。
   * 经验公式 26 + 13√n 在两个方向上都会错:小社区太松、大社区太紧。
   */
  const localRadius: number[] = members.map((m) =>
    Math.max(
      TARGET_SPACING,
      Math.sqrt((m.length * TARGET_SPACING * TARGET_SPACING) / Math.PI) * 1.15,
    ),
  );

  const local: Vec2[] = Array.from({ length: nodeCount }, () => ({ x: 0, y: 0 }));

  members.forEach((idx, c) => {
    if (!idx.length) return;
    const R = localRadius[c] ?? TARGET_SPACING;

    for (const i of idx) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * R * 0.75;
      local[i] = { x: Math.cos(a) * rr, y: Math.sin(a) * rr };
    }

    const inSet = new Set(idx);
    const inner = edges.filter(([a, b]) => inSet.has(a) && inSet.has(b));
    const cell = Math.max(12, R / 4);

    for (let iter = 0; iter < 160; iter++) {
      repulsion(local, idx, cell, 26, R * 2.2);

      for (const [a, b] of inner) {
        const pa = local[a];
        const pb = local[b];
        if (!pa || !pb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const d = Math.max(0.5, Math.hypot(dx, dy));
        const f = (d - 30) * 0.02;
        const ux = dx / d;
        const uy = dy / d;
        pa.x += ux * f;
        pa.y += uy * f;
        pb.x -= ux * f;
        pb.y -= uy * f;
      }

      // 向心:把社区捏成一团,而不是无限摊开
      for (const i of idx) {
        const p = local[i];
        if (!p) continue;
        const d = Math.hypot(p.x, p.y);
        if (d > R) {
          const k = R / d;
          p.x *= k;
          p.y *= k;
        }
      }
    }

    // 布局完再统一缩放到 0.92R:既保证装得进圆盘,又让圆盘被用满
    let spread = 0;
    for (const i of idx) {
      const p = local[i];
      if (p) spread = Math.max(spread, Math.hypot(p.x, p.y));
    }
    if (spread > 0) {
      const k = (R * 0.92) / spread;
      for (const i of idx) {
        const p = local[i];
        if (!p) continue;
        p.x *= k;
        p.y *= k;
      }
    }
  });

  // ---------- 2. 社区排布 ----------
  const centers: Vec2[] = members.map(() => ({ x: 0, y: 0 }));
  const order = members
    .map((_, i) => i)
    .sort((a, b) => (members[b]?.length ?? 0) - (members[a]?.length ?? 0));

  const anchor =
    anchorCommunity >= 0 && anchorCommunity < communityCount
      ? anchorCommunity
      : (order[0] ?? 0);
  const maxSpan = Math.min(width, height) * 0.42;

  order.forEach((c, k) => {
    if (c === anchor) {
      centers[c] = { x: 0, y: 0 };
      return;
    }
    // 斐波那契式螺旋:大社区靠内,小社区靠外
    const t = k / Math.max(1, order.length - 1);
    const ang = t * Math.PI * 2 * 1.6 + (k % 2 ? 0.7 : 0);
    const rad = maxSpan * (0.34 + 0.62 * t);
    centers[c] = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad * 0.78 };
  });

  const cross = new Map<string, number>();
  for (const [a, b] of edges) {
    const la = labels[a] ?? 0;
    const lb = labels[b] ?? 0;
    if (la === lb) continue;
    const k = la < lb ? `${la}-${lb}` : `${lb}-${la}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }
  const crossList = [...cross.entries()]
    .map(([k, w]) => {
      const [a, b] = k.split("-").map(Number);
      return { a: a ?? 0, b: b ?? 0, w };
    })
    .filter((e) => e.a !== e.b);

  /**
   * 社区排布分两步,顺序很关键。
   *
   * 踩过的坑:原来把「跨社区引用多就拉近」和「圆盘互相推开」放在同一个循环里,
   * 结果吸引力远大于斥力,社区被拉到中心间距 77px、而半径各有 2000+ ——
   * 完全重叠,视觉上就是「领域也挤在一起」。
   *
   * 现在:第一步只用吸引力做**软偏好**(谁跟谁更相关),幅度小;
   * 第二步用**硬性不重叠**做投影:只要两圆相交就推回到相切。
   * 硬约束保证结果一定可读,软偏好只负责让相关的社区挨近一点。
   */
  const SEPARATION = 1.12; // 圆盘之间留 12% 空隙,星云才不会粘成一片
  for (let iter = 0; iter < 260; iter++) {
    if (iter < 120) {
      for (const e of crossList) {
        if (e.a === anchor || e.b === anchor) continue;
        const ca = centers[e.a];
        const cb = centers[e.b];
        if (!ca || !cb) continue;
        const dx = cb.x - ca.x;
        const dy = cb.y - ca.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const pull = Math.min(0.5, e.w * 0.002);
        ca.x += (dx / d) * pull;
        ca.y += (dy / d) * pull;
        cb.x -= (dx / d) * pull;
        cb.y -= (dy / d) * pull;
      }
    }

    for (let pass = 0; pass < 3; pass++) {
      for (let a = 0; a < communityCount; a++) {
        for (let b = a + 1; b < communityCount; b++) {
          const ca = centers[a];
          const cb = centers[b];
          if (!ca || !cb) continue;

          const minD = ((localRadius[a] ?? 0) + (localRadius[b] ?? 0)) * SEPARATION;
          let dx = cb.x - ca.x;
          let dy = cb.y - ca.y;
          let d = Math.hypot(dx, dy);
          if (d < 0.01) {
            dx = rnd() - 0.5;
            dy = rnd() - 0.5;
            d = 0.1;
          }
          if (d >= minD) continue;

          const aFixed = a === anchor;
          const bFixed = b === anchor;
          if (aFixed && bFixed) continue;

          const overlap = (minD - d) / d;
          if (aFixed) {
            cb.x += dx * overlap;
            cb.y += dy * overlap;
          } else if (bFixed) {
            ca.x -= dx * overlap;
            ca.y -= dy * overlap;
          } else {
            cb.x += dx * overlap * 0.5;
            cb.y += dy * overlap * 0.5;
            ca.x -= dx * overlap * 0.5;
            ca.y -= dy * overlap * 0.5;
          }
        }
      }
    }
    centers[anchor] = { x: 0, y: 0 };
  }

  // ---------- 3. 世界坐标 ----------
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  members.forEach((idx, c) => {
    const center = centers[c];
    if (!center) return;
    for (const i of idx) {
      const p = local[i];
      if (!p) continue;
      minX = Math.min(minX, center.x + p.x);
      maxX = Math.max(maxX, center.x + p.x);
      minY = Math.min(minY, center.y + p.y);
      maxY = Math.max(maxY, center.y + p.y);
    }
  });

  if (!Number.isFinite(minX)) {
    minX = maxX = minY = maxY = 0;
  }

  /**
   * 这里**不**把布局压进固定的世界盒子。
   *
   * 踩过的大坑:原来这一行是
   *     scale = min((w-2p)/spanX, (h-2p)/spanY, 1.35)
   * 意思是「不管多少节点都塞进 1600×1000」。节点一多就压得越狠 ——
   * 实测 696 篇真实论文被压到最近邻间距中位 4.9px(设计目标 64px,紧 13 倍),
   * 视觉上就是「所有星星挤在一起、领域云糊成一片」。
   *
   * 正确的关系是反过来的:**世界尺寸由布局算出来**,而不是布局迁就世界。
   * 整体缩放交给 normalizeDensity() 按目标星间距决定。
   */
  const offX = width / 2 - (minX + maxX) / 2;
  const offY = height / 2 - (minY + maxY) / 2;

  const positions: Vec2[] = Array.from({ length: nodeCount }, (_, i) => {
    const center = centers[labels[i] ?? 0] ?? { x: 0, y: 0 };
    const p = local[i] ?? { x: 0, y: 0 };
    return { x: center.x + p.x + offX, y: center.y + p.y + offY };
  });

  const clusters: ClusterPlacement[] = members.map((idx) => {
    if (!idx.length) return { cx: width / 2, cy: height / 2, r: 40, n: 0 };
    let sx = 0;
    let sy = 0;
    for (const i of idx) {
      sx += positions[i]?.x ?? 0;
      sy += positions[i]?.y ?? 0;
    }
    const cx = sx / idx.length;
    const cy = sy / idx.length;
    let r = 0;
    for (const i of idx) {
      const p = positions[i];
      if (p) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    }
    return { cx, cy, r: Math.max(44, r * 1.22), n: idx.length };
  });

  return { positions, clusters };
}

/**
 * 带锚点的增量松弛 —— 星空累积时用它,而不是全量重排。
 *
 * 老星体被锚点拉在自己的位置上,新星体自由移动。
 * 结果是:加入一篇新种子时,老结构只轻微调整,不会整体跳走 ——
 * 实测加入第二篇种子后老星体位移中位数约占世界尺度的 2%。
 */
export function relaxWithAnchors(
  n: number,
  edges: Array<[number, number]>,
  pos: Vec2[],
  anchors: Array<Vec2 | null>,
  opts: { iterations?: number; anchorWeight?: number; targetLength?: number } = {},
): void {
  const { iterations = 140, anchorWeight = 0.2, targetLength = 34 } = opts;
  const all = Array.from({ length: n }, (_, i) => i);
  const cell = Math.max(16, targetLength);

  for (let iter = 0; iter < iterations; iter++) {
    repulsion(pos, all, cell, 30, targetLength * 3);

    for (const [a, b] of edges) {
      const pa = pos[a];
      const pb = pos[b];
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.max(0.5, Math.hypot(dx, dy));
      const f = (d - targetLength) * 0.03;
      const ux = dx / d;
      const uy = dy / d;
      pa.x += ux * f;
      pa.y += uy * f;
      pb.x -= ux * f;
      pb.y -= uy * f;
    }

    // 锚点把老星体拉回原位;权重随迭代衰减,保证收敛
    const w = anchorWeight * (1 - iter / iterations / 2);
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      const p = pos[i];
      if (!a || !p) continue;
      p.x += (a.x - p.x) * w;
      p.y += (a.y - p.y) * w;
    }
  }
}

/**
 * 最近邻距离的中位数 —— 密度的度量。
 *
 * 曾经用网格近似加速,结果**量错了**(报 64px 而真实是 34px),密度归一化因此过度缩放。
 * 密度是布局的核心指标,值得用精确算法:n≤700 时约 49 万次距离计算,几毫秒而已。
 */
export function medianNearestNeighbor(positions: Vec2[]): number {
  const n = positions.length;
  if (n < 2) return 0;

  const nearest: number[] = [];
  for (let i = 0; i < n; i++) {
    const pi = positions[i];
    if (!pi) continue;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const pj = positions[j];
      if (!pj) continue;
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const v = dx * dx + dy * dy;
      if (v < best) best = v;
    }
    if (Number.isFinite(best)) nearest.push(Math.sqrt(best));
  }
  if (!nearest.length) return 0;
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)] ?? 0;
}

/**
 * 密度归一化:把整体缩放调到目标星间距。
 *
 * 整体缩放是**保结构**的(相对位置完全不变),所以它不会破坏累积时
 * 「老星体留在原地」的承诺 —— 屏幕上看到的只是「星空整体拉远了一点」。
 * 加阈值是为了自稳:间距达标后 k≈1,后续建图不再反复微调。
 */
export function normalizeDensity(
  positions: Vec2[],
  target = TARGET_SPACING,
): { median: number; scale: number } {
  const median = medianNearestNeighbor(positions);
  if (!median || positions.length < 2) return { median, scale: 1 };

  const k = target / median;
  if (k < 0.85 || k > 1.18) {
    let sx = 0;
    let sy = 0;
    for (const p of positions) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / positions.length;
    const cy = sy / positions.length;
    for (const p of positions) {
      p.x = cx + (p.x - cx) * k;
      p.y = cy + (p.y - cy) * k;
    }
    return { median: medianNearestNeighbor(positions), scale: k };
  }
  return { median, scale: 1 };
}
