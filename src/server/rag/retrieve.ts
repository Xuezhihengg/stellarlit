/**
 * 检索 —— 词面 BM25 + 图结构扩展。
 *
 * 两个策略:
 *   1. 先用 BM25 找最相关的文本块(摘要/关系证据);
 *   2. 再看命中的论文在图里连着谁,把它们的**关系证据**补进上下文。
 *
 * 第二条是"星图 + RAG"真正结合的地方:普通 RAG 只按文本相似度找段落,
 * 而这里知道"这几篇论文之间有一条被核验过的边"——问关系类问题时,
 * 检索结果会主动带上关系证据,而不是等用户自己拼。
 */

import { buildBm25, searchBm25, type Bm25Index } from "@/lib/rag/bm25";
import { tokenizeForSearch } from "@/lib/rag/text";
import type { StarfieldPayload } from "@/types/api";

import { buildCorpus, type RagChunk, type RagSource } from "./corpus";

export interface RetrievedSource extends RagSource {
  score: number;
}

interface Cached {
  chunks: RagChunk[];
  index: Bm25Index;
}

const cache = new Map<string, Cached>();

function corpusFor(payload: StarfieldPayload): Cached {
  const key = `${payload.starfield.id}:${payload.starfield.updatedAt}:${payload.graph.stats.papers}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const corpus = buildCorpus(payload);
  const entry: Cached = {
    chunks: corpus.chunks,
    index: buildBm25(corpus.chunks.map((c) => ({ id: c.chunkId, tokens: c.tokens }))),
  };
  if (cache.size > 16) cache.clear();
  cache.set(key, entry);
  return entry;
}

export function retrieveSources(
  payload: StarfieldPayload,
  question: string,
  limit = 8,
): RetrievedSource[] {
  const { chunks, index } = corpusFor(payload);
  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  const hits = searchBm25(index, tokenizeForSearch(question), limit * 3);
  if (!hits.length) return [];

  const picked: RetrievedSource[] = [];
  for (const hit of hits) {
    const chunk = byId.get(hit.id);
    if (!chunk) continue;
    picked.push({ ...chunk, score: hit.score });
    if (picked.length >= limit) break;
  }

  /**
   * 图扩展:命中最靠前的几篇论文,把它们相连的关系证据补进来。
   *
   * 只用命中论文的**现有边**,不额外推断,所以不会引入没有证据的关系。
   */
  const topPapers = new Set<string>();
  for (const item of picked.slice(0, 4)) {
    for (const id of item.paperIds) topPapers.add(id);
    if (topPapers.size >= 3) break;
  }

  const used = new Set(picked.map((p) => p.chunkId));
  const bridgeScore = picked[0]?.score ?? 1;
  for (const chunk of chunks) {
    if (picked.length >= limit) break;
    if (chunk.section !== "relation" || used.has(chunk.chunkId)) continue;
    if (!chunk.paperIds.some((id) => topPapers.has(id))) continue;
    picked.push({ ...chunk, score: bridgeScore * 0.4 });
    used.add(chunk.chunkId);
  }

  return picked;
}
