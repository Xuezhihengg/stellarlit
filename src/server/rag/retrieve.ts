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
  /**
   * 同一篇摘要只保留最相关的一块。
   *
   * 摘要切块之间自带重叠(否则答案正好落在交界处会丢半句),但重叠块
   * 同时命中时,上下文里会出现大段重复文本:既浪费 token,也会让回答
   * 重复同一句话。所以按"论文 + 章节"去重,只留分数最高的那块。
   */
  const seenSection = new Set<string>();
  for (const hit of hits) {
    const chunk = byId.get(hit.id);
    if (!chunk) continue;
    const key = `${chunk.paperId}|${chunk.section}`;
    if (chunk.section !== "relation" && seenSection.has(key)) continue;
    picked.push({ ...chunk, score: hit.score });
    seenSection.add(key);
    if (picked.length >= limit) break;
  }

  /**
   * 图扩展:命中最靠前的几篇论文,把它们相连的关系证据补进来。
   *
   * 只用命中论文的**现有边**,不额外推断,所以不会引入没有证据的关系。
   */
  /**
   * 图扩展只围绕**问题最相关的那篇论文**展开。
   *
   * 之前会从"前两条命中"里收集论文,而命中本身可能是关系块 ——
   * 于是问 YOLO 时把 R-CNN 的整串关系也拉了进来。现在只认第一条
   * 非关系块的主论文,补它的关系证据,噪声小得多。
   */
  const anchorPaper =
    picked.find((p) => p.section !== "relation")?.paperId ?? picked[0]?.paperId;

  const used = new Set(picked.map((p) => p.chunkId));
  const bridgeScore = picked[0]?.score ?? 1;
  let bridged = 0;
  for (const chunk of chunks) {
    if (picked.length >= limit || bridged >= 2) break;
    if (chunk.section !== "relation" || used.has(chunk.chunkId)) continue;
    if (!anchorPaper || !chunk.paperIds.includes(anchorPaper)) continue;
    picked.push({ ...chunk, score: bridgeScore * 0.4 });
    used.add(chunk.chunkId);
    bridged++;
  }

  return picked;
}
