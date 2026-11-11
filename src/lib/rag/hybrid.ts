/**
 * 混合召回的两个纯函数。
 *
 * RRF 只看名次、不看分数:BM25 的分数没有上界,余弦相似度落在 -1~1,
 * 两者直接相加会被 BM25 单方面支配。按名次融合可以把两路信号放在同一把尺子上。
 */

export interface RankedList {
  ids: string[];
  /** 相对权重。默认 1;子问题与同义改写可以略低于原问题。 */
  weight?: number;
}

/** Reciprocal Rank Fusion:score = Σ weight / (k + rank)。 */
export function reciprocalRankFusion(lists: RankedList[], k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();
    for (const [index, id] of list.ids.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + index + 1));
    }
  }
  return fused;
}

export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm <= 1e-12) return vector.map(() => 0);
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

/** 输入若已归一化,它就是一次点积;这里仍做完整计算,避免调用方踩隐式约定。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 1e-12 || normB <= 1e-12) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 按分数倒序取 id;分数小于等于 0 的候选不进入排名。 */
export function rankedIds(scores: Map<string, number>, minScore = 0): string[] {
  return [...scores.entries()]
    .filter(([, score]) => score > minScore)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}
