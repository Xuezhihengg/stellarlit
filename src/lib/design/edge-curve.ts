/**
 * 边的几何 —— 一条边在屏幕坐标下"长什么样"。
 *
 * 同一份形状有三个地方要用:画线、粒子的轨迹、关系标签的落点。
 * 各写一份的话迟早会漂移,而且已经漂过一次:标签取的是**直线**的中点,
 * 而线画成弧线,于是标签悬在离自己那条线十几像素的地方 ——
 * 看上去像一句"不属于任何一条线"的注释,越放大越明显。
 *
 * 所以这里只留一个函数算形状,谁要谁取:
 *   形状 = 两端 + 一个控制点(二次贝塞尔),弯度由边 id 派生 ——
 *   同一条边每一帧形状一致,不会随缩放抖成另一条线。
 */

import { hashSeed } from "@/lib/graph/rng";

/** 二次贝塞尔:两端与一个控制点。 */
export interface EdgeCurve {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

/**
 * 由两端算出这条边的弧线。
 *
 * 直线在密集处会让整张图变成一张渔网 —— 几十条线共用一个方向时,
 * 眼睛会把它们读成一块灰度背景,而不是"谁连着谁"。给每条边一个垂直于
 * 自身的偏移(边越短弧越明显,下限 7px),线束自然散开,走向也读得出来。
 */
export function edgeCurve(ax: number, ay: number, bx: number, by: number, id: string): EdgeCurve {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const seed = hashSeed(id) / 4294967296;
  const bow = Math.max(7, Math.min(30, len * 0.17)) * (seed < 0.5 ? -1 : 1) * (0.6 + seed * 0.8);
  const n = Math.max(1, len);

  return {
    ax,
    ay,
    bx,
    by,
    cx: (ax + bx) / 2 + (-dy / n) * bow,
    cy: (ay + by) / 2 + (dx / n) * bow,
  };
}

/** 弧线上参数 t 处的点(0 = a 端,1 = b 端)。 */
export function pointOnEdge(c: EdgeCurve, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * c.ax + 2 * u * t * c.cx + t * t * c.bx,
    y: u * u * c.ay + 2 * u * t * c.cy + t * t * c.by,
  };
}

/** 由边 id 派生的稳定随机数(0~1)。粒子的相位、弧的朝向都用它。 */
export function edgeSeed(id: string): number {
  return hashSeed(id) / 4294967296;
}
