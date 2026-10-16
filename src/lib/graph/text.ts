/**
 * 本地文本相似度 —— 用 TF-IDF 余弦,不依赖任何外部服务。
 *
 * 为什么值得自己写这一份:
 *   判定候选的**排序质量**直接决定成本。一次建图只送审有限的几十对,
 *   如果排在前面的都是"看起来沾边其实无关"的论文,那模型的调用额度和
 *   用户的等待就都白花了 —— 实测命中率只有 10%,问题就出在这里。
 *
 *   最省事的替代方案是接一个向量模型,但那要额外配置密钥、额外付费、
 *   还要多一跳网络。而标题 + 摘要的 TF-IDF 在**排序**这个用途上已经足够:
 *   我们不需要精确的语义距离,只需要把明显无关的排到后面去。
 *   真正判断关系的是大模型,这里只负责把好钢用在刀刃上。
 *
 * 它是纯函数、零依赖,因此也能脱离服务端跑单测。
 */

/** 英文停用词只列高频且无区分度的那些 —— 长列表带来的收益远小于维护成本。 */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "are", "was", "were", "have", "has", "had",
  "from", "which", "these", "those", "such", "than", "then", "there", "their", "them",
  "can", "could", "would", "should", "may", "might", "must", "not", "but", "also", "into",
  "using", "used", "use", "based", "our", "we", "you", "they", "its", "it", "as", "an", "of",
  "in", "on", "at", "to", "by", "or", "is", "be", "we", "been", "more", "most", "other",
  "however", "thus", "while", "when", "where", "how", "what", "all", "both", "each", "both",
]);

/**
 * 切词。
 *
 * 英文按空白与标点切;中日韩**逐字**成词 —— 中文分词需要词典或模型,
 * 而逐字的 bigram 在相似度任务上表现已经够用(与标题匹配用的是同一套思路)。
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const normalized = text.toLowerCase();

  // 先把 CJK 连成 bigram,再按非字母数字切开处理拉丁词
  const cjk = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    if (run.length === 1) out.push(run);
  }

  for (const word of normalized.split(/[^a-z0-9]+/)) {
    if (word.length < 3) continue;
    if (STOP.has(word)) continue;
    out.push(word);
  }

  return out;
}

export interface TextIndex {
  /** 每篇文档的归一化 TF-IDF 向量 */
  vectors: Map<string, Map<string, number>>;
  /** 文档数,用于判断索引是否可用 */
  size: number;
}

/**
 * 建立索引。
 *
 * IDF 用平滑形式 `ln((N+1)/(df+1)) + 1`:语料里只出现一次的少数词不会
 * 被赋予极端权重,而在只有几十篇文档的小语料上这点尤其重要。
 */
export function buildTextIndex(docs: Array<{ id: string; text: string }>): TextIndex {
  const tokenized = docs.map((d) => ({ id: d.id, tokens: tokenize(d.text) }));
  const df = new Map<string, number>();

  for (const doc of tokenized) {
    for (const t of new Set(doc.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const n = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log((n + 1) / (d + 1)) + 1);

  const vectors = new Map<string, Map<string, number>>();
  for (const doc of tokenized) {
    const tf = new Map<string, number>();
    for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    const vec = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of tf) {
      const w = (1 + Math.log(count)) * (idf.get(term) ?? 1);
      vec.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [term, w] of vec) vec.set(term, w / norm);
    vectors.set(doc.id, vec);
  }

  return { vectors, size: docs.length };
}

/** 余弦相似度。两个向量都已归一化,所以点积就是余弦。 */
export function cosineSimilarity(index: TextIndex, aId: string, bId: string): number {
  const a = index.vectors.get(aId);
  const b = index.vectors.get(bId);
  if (!a || !b) return 0;

  // 遍历较短的那个,稀疏向量上这能省掉一半以上的查找
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other) dot += w * other;
  }
  return Math.max(0, Math.min(1, dot));
}

/** 把标题与摘要拼成一篇"文档"。标题重复一次,提高它的权重。 */
export function documentOf(title: string, abstract?: string): string {
  return `${title} ${title} ${abstract ?? ""}`;
}
