/**
 * 动效的时间函数。
 *
 * 放 lib 而不是就地写:同一条曲线如果在几处各写一遍,迟早会出现
 * "这个环的退场比那条标签的进场快一点"这种说不清来源的差异 ——
 * 而"丝滑"恰恰取决于所有东西共用同一条曲线。
 *
 * 约定:只吃 0~1 的进度、只吐 0~1 的进度,不碰时钟、不碰画面。
 * 于是它们既能在渲染循环里用,也能在检查脚本里跑。
 */

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 平滑阶跃:在 edge0 处为 0、edge1 处为 1,两端导数为 0。
 * 两端导数不为 0 的曲线,起步和收尾都会有一眼能看出来的"顿"。
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 缓出二次:0→1 快进慢收。用于"已经在动的东西如何安顿下来"。 */
export function easeOutQuad(x: number): number {
  const t = clamp01(x);
  return 1 - (1 - t) * (1 - t);
}
