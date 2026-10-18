/**
 * BM25 —— 不依赖向量模型的检索基线。
 *
 * 为什么先做它而不是直接上 embedding:
 *   1. 演示现场不保证有向量模型密钥,而检索不能因此整个不可用;
 *   2. 学术问题的关键词很具体(YOLO、mAP、Faster R-CNN),词面检索本来就强;
 *   3. 它能在 Node 里跑确定性断言,后续接向量检索时也有一个可对比的基线。
 *
 * 纯函数、零依赖。
 */

export interface SearchDoc {
  id: string;
  tokens: string[];
}

export interface Bm25Index {
  docs: SearchDoc[];
  /** term → 出现在多少篇文档里 */
  df: Map<string, number>;
  avgLength: number;
  k1: number;
  b: number;
}

export interface SearchHit {
  id: string;
  score: number;
}

export function buildBm25(docs: SearchDoc[], options: { k1?: number; b?: number } = {}): Bm25Index {
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const total = docs.reduce((n, d) => n + d.tokens.length, 0);
  return {
    docs,
    df,
    avgLength: docs.length ? total / docs.length : 0,
    k1: options.k1 ?? 1.2,
    b: options.b ?? 0.75,
  };
}

/** 查询词频(查询内部的重复不重复计分)。 */
function queryTerms(tokens: string[]): Set<string> {
  return new Set(tokens);
}

export function searchBm25(index: Bm25Index, query: string[], limit = 20): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.size || !index.docs.length) return [];

  const n = index.docs.length;
  const hits: SearchHit[] = [];

  for (const doc of index.docs) {
    const length = doc.tokens.length || 1;
    let score = 0;

    // 文档内词频
    const tf = new Map<string, number>();
    for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);

    for (const term of terms) {
      const freq = tf.get(term);
      if (!freq) continue;
      const df = index.df.get(term) ?? 0;
      if (!df) continue;
      // 平滑 IDF:稀有词更有信息量,但不会因为只出现一次而爆炸
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = freq * (index.k1 + 1);
      const denom = freq + index.k1 * (1 - index.b + (index.b * length) / (index.avgLength || 1));
      score += idf * (norm / denom);
    }

    if (score > 0) hits.push({ id: doc.id, score });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
