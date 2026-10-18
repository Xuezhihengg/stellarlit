/**
 * 星云轮廓。
 *
 * 问题:一段径向渐变画出来的圆,无论多柔,读起来都是"一个光晕" ——
 * 边界是完美的圆,而星云之所以像星云,恰恰因为边界**不是**圆的。
 *
 * 做法:在一个圆上让半径随角度起伏。三个不同频率的正弦叠在一起:
 * 低频(3 次)决定大块的凸起与凹陷,中频(5 次)让形状不对称,
 * 高频(8 次)只负责边缘的毛糙。三者都由同一个种子决定,
 * 所以同一团云每一帧形状一致,不会随动画"沸腾"。
 *
 * 纯几何、零依赖:渲染层只负责把点连成曲线并填色。
 */

export interface OutlinePoint {
  x: number;
  y: number;
}

/**
 * 生成一圈闭合的轮廓点(逆时针,首尾不重复)。
 *
 * @param amount 起伏强度:0 = 正圆;0.12 左右已经能看出"不是圆的"。
 */
export function nebulaOutline(
  cx: number,
  cy: number,
  r: number,
  seed: number,
  amount = 0.13,
  points = 22,
): OutlinePoint[] {
  const phase = seed * Math.PI * 2;
  const out: OutlinePoint[] = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const wobble =
      1 +
      amount * Math.sin(3 * angle + phase) +
      amount * 0.6 * Math.sin(5 * angle + phase * 1.7) +
      amount * 0.25 * Math.sin(8 * angle + phase * 2.3);
    const rr = r * wobble;
    out.push({ x: cx + Math.cos(angle) * rr, y: cy + Math.sin(angle) * rr });
  }
  return out;
}
