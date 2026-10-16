/**
 * 确定性随机数。
 *
 * 图算法里到处都需要"随机":标签传播的打乱顺序、多次重启的初始标签、
 * 初始布局的撒点。用 Math.random 的话同一份数据每次跑出来都不一样,
 * 既无法复现问题,也无法承诺「派生层的结果可复算」。
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由字符串派生一个稳定种子 —— 用来把「种子论文」映射成布局参数。 */
export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
