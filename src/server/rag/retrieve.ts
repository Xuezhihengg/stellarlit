/**
 * 检索 —— BM25 + 向量混合召回 + RRF + 图结构扩展 + 意图重排。
 *
 * 这条链路解决四类容易漏召回的问题:
 *   1. 中英混问 / 同义表达:查询规划补英文同义词,词面与向量同时召回;
 *   2. 比较三篇以上:先按论文拆子问题,再按多锚点补关系证据;
 *   3. 两路分数不可比:BM25 与余弦都先变成名次,再用 RRF 融合;
 *   4. 召回多但顺序差:最后按问题覆盖、论文命中、章节意图与图证据重排。
 *
 * 向量模型不可用不是错误:自动退回 BM25,并在 diagnostics 里如实标注。
 */

import { buildBm25, searchBm25, type Bm25Index } from "@/lib/rag/bm25";
import {
  cosineSimilarity,
  rankedIds,
  reciprocalRankFusion,
} from "@/lib/rag/hybrid";
import { tokenizeForSearch } from "@/lib/rag/text";
import type { StarfieldPayload } from "@/types/api";

import { buildCorpus, type RagChunk, type RagSource, type RagSection } from "./corpus";
import {
  defaultEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding";
import { buildQueryPlan, type QueryIntent, type QueryPlan } from "./query";

export interface RetrievedSource extends RagSource {
  score: number;
  recall?: {
    lexicalRank?: number;
    vectorRank?: number;
    graph?: boolean;
  };
}

export interface RetrievalDiagnostics {
  intent: QueryIntent;
  mode: "hybrid" | "lexical";
  queryVariants: string[];
  lexicalHits: number;
  vectorHits: number;
  graphRelations: number;
  sourceCount: number;
  coverage: number;
  topScore: number;
  threshold: number;
  enough: boolean;
  mentionedPapers: number;
  missingPaperIds: string[];
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  diagnostics: RetrievalDiagnostics;
}

export interface RetrievalOptions {
  /** 当前账号:向量模型按账号绑定解析。 */
  ownerId?: string;
  /** 关掉图扩展用于对照实验;线上默认开启。 */
  graph?: boolean;
  /** 测试或特殊部署可注入;undefined 表示使用服务端配置。 */
  embedding?: EmbeddingProvider | null;
  /** 客户端断开时中止向量请求。 */
  signal?: AbortSignal;
}

interface Cached {
  chunks: RagChunk[];
  index: Bm25Index;
  vectorsByProvider: Map<string, number[][] | null>;
}

const cache = new Map<string, Cached>();

function corpusFor(payload: StarfieldPayload): Cached {
  const key = [
    payload.starfield.id,
    payload.starfield.updatedAt,
    payload.graph.stats.papers,
    payload.graph.stats.edges,
  ].join(":");
  const hit = cache.get(key);
  if (hit) return hit;

  const corpus = buildCorpus(payload);
  const entry: Cached = {
    chunks: corpus.chunks,
    index: buildBm25(corpus.chunks.map((chunk) => ({ id: chunk.chunkId, tokens: chunk.tokens }))),
    vectorsByProvider: new Map(),
  };
  if (cache.size > 16) cache.clear();
  cache.set(key, entry);
  return entry;
}

async function chunkVectors(
  entry: Cached,
  provider: EmbeddingProvider,
): Promise<number[][] | null> {
  if (entry.vectorsByProvider.has(provider.id)) {
    return entry.vectorsByProvider.get(provider.id) ?? null;
  }
  const vectors = await provider.embed(
    entry.chunks.map((chunk) => `${chunk.title}\n${chunk.section}\n${chunk.text}`),
  );
  const usable = vectors && vectors.length === entry.chunks.length ? vectors : null;
  entry.vectorsByProvider.set(provider.id, usable);
  return usable;
}

function rankMap(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index + 1]));
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

const STOP_TOKENS = new Set([
  "什么",
  "哪些",
  "怎么",
  "如何",
  "为什么",
  "之间",
  "论文",
  "工作",
  "关系",
  "是否",
  "可以",
  "一下",
  "这些",
  "那些",
  "这篇",
  "它们",
  "有哪",
  "么关",
  "么样",
  "介绍",
  "讲讲",
  "分别",
  "以及",
  "还有",
]);

function conceptTokens(question: string): string[] {
  return [
    ...new Set(
      tokenizeForSearch(question).filter(
        (token) => token.length >= 2 && !STOP_TOKENS.has(token),
      ),
    ),
  ];
}

function coverageOf(tokens: string[], texts: string[]): number {
  if (!tokens.length) return 1;
  const haystack = texts.join(" ").toLowerCase();
  let hit = 0;
  for (const token of tokens) if (haystack.includes(token)) hit++;
  return hit / tokens.length;
}

function sectionBoost(section: RagSection, intent: QueryIntent): number {
  if (intent === "relation" || intent === "comparison") {
    if (section === "relation") return 0.08;
    if (section === "abstract") return 0.03;
    return 0;
  }
  if (section === "abstract") return 0.05;
  if (section === "title") return 0.03;
  return 0;
}

/** 图扩展:先补「问题点名的论文对」,再按锚点轮流补各自的关系证据。 */
function graphRelations(
  chunks: RagChunk[],
  base: RetrievedSource[],
  mentionedIds: string[],
  limit: number,
  intent: QueryIntent,
  baseScore: number,
): RetrievedSource[] {
  const relationChunks = chunks.filter((chunk) => chunk.section === "relation");
  if (!relationChunks.length || limit <= 0) return [];

  const used = new Set(base.map((source) => source.chunkId));
  const selected: RetrievedSource[] = [];
  const budget = Math.min(limit, intent === "comparison" ? 8 : 4);

  const take = (chunk: RagChunk): boolean => {
    if (used.has(chunk.chunkId) || selected.length >= budget) return false;
    used.add(chunk.chunkId);
    selected.push({ ...chunk, score: baseScore, recall: { graph: true } });
    return true;
  };

  if (intent === "comparison" || intent === "relation") {
    for (let i = 0; i < mentionedIds.length; i++) {
      for (let j = i + 1; j < mentionedIds.length; j++) {
        const a = mentionedIds[i]!;
        const b = mentionedIds[j]!;
        for (const chunk of relationChunks) {
          if (chunk.paperIds.includes(a) && chunk.paperIds.includes(b)) take(chunk);
        }
      }
    }
  }

  const anchors = (
    mentionedIds.length
      ? [...new Set(mentionedIds)]
      : [
          ...new Set(
            base
              .filter((source) => source.section !== "relation")
              .map((source) => source.paperId),
          ),
        ]
  ).slice(0, 4);

  const byAnchor = new Map<string, RagChunk[]>();
  for (const anchor of anchors) {
    byAnchor.set(
      anchor,
      relationChunks.filter((chunk) => chunk.paperIds.includes(anchor)),
    );
  }

  // 轮流取,避免第一篇论文的关系边占满所有名额。
  for (let depth = 0; depth < 2 && selected.length < budget; depth++) {
    for (const anchor of anchors) {
      if (selected.length >= budget) break;
      const chunk = byAnchor.get(anchor)?.[depth];
      if (chunk) take(chunk);
    }
  }

  return selected;
}

function rerank(
  candidates: RetrievedSource[],
  plan: QueryPlan,
  tokens: string[],
): RetrievedSource[] {
  if (!candidates.length) return [];
  const maxScore = Math.max(...candidates.map((source) => source.score), 1e-9);

  return candidates
    .map((source) => {
      const normalized = source.score / maxScore;
      const concept = coverageOf(tokens, [`${source.title} ${source.text}`]);
      const title = coverageOf(tokens, [source.title]);
      const mentioned = plan.mentionedPaperIds.some((id) => source.paperIds.includes(id)) ? 1 : 0;
      const score =
        normalized * 0.44 +
        concept * 0.26 +
        title * 0.1 +
        mentioned * 0.1 +
        (plan.mentionedPaperIds.length && !mentioned ? -0.12 : 0) +
        sectionBoost(source.section, plan.intent) +
        (source.recall?.graph ? 0.04 : 0);
      return { ...source, score };
    })
    .sort((a, b) => b.score - a.score);
}

function ensureCoverage(
  ranked: RetrievedSource[],
  plan: QueryPlan,
  limit: number,
): RetrievedSource[] {
  if (limit <= 0) return [];
  const picked: RetrievedSource[] = [];
  const used = new Set<string>();
  const push = (source: RetrievedSource | undefined) => {
    if (!source || used.has(source.chunkId) || picked.length >= limit) return;
    used.add(source.chunkId);
    picked.push(source);
  };

  // 比较题每一篇点名的论文至少留一块原文,否则「比较」会退化成只讲其中两篇。
  for (const id of plan.mentionedPaperIds) {
    push(ranked.find((source) => source.paperIds.includes(id)));
  }

  if (plan.intent === "relation" || plan.intent === "comparison") {
    for (let i = 0; i < plan.mentionedPaperIds.length; i++) {
      for (let j = i + 1; j < plan.mentionedPaperIds.length; j++) {
        const key = pairKey(plan.mentionedPaperIds[i]!, plan.mentionedPaperIds[j]!);
        push(
          ranked.find(
            (source) =>
              source.section === "relation" &&
              source.paperIds.length >= 2 &&
              pairKey(source.paperIds[0]!, source.paperIds[1]!) === key,
          ),
        );
      }
    }
  }

  for (const source of ranked) push(source);
  return picked.sort((a, b) => b.score - a.score);
}

export async function retrieveSourcesDetailed(
  payload: StarfieldPayload,
  question: string,
  limit = 8,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const { chunks, index } = corpusFor(payload);
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const plan = buildQueryPlan(payload, question);
  const useGraph = options.graph ?? true;

  const lexicalLists = plan.variants.map((variant) => ({
    ids: searchBm25(index, tokenizeForSearch(variant.text), Math.max(limit * 5, 30)).map(
      (hit) => hit.id,
    ),
    weight: variant.weight,
  }));
  const lexicalFused = reciprocalRankFusion(lexicalLists);
  const lexicalIds = rankedIds(lexicalFused);

  const provider =
    options.embedding === undefined
      ? await defaultEmbeddingProvider(options.ownerId ?? "legacy", options.signal)
      : options.embedding;
  let vectorIds: string[] = [];
  if (provider) {
    const vectors = await chunkVectors(corpusFor(payload), provider);
    const queryVectors = vectors
      ? await provider.embed(plan.variants.map((variant) => variant.text))
      : null;
    if (vectors && queryVectors && queryVectors.length === plan.variants.length) {
      const perVariant = queryVectors.map((queryVector) => {
        const scores = new Map<string, number>();
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const vector = vectors[chunkIndex];
          if (vector) scores.set(chunk.chunkId, cosineSimilarity(queryVector, vector));
        }
        return rankedIds(scores, 0.08);
      });
      vectorIds = rankedIds(
        reciprocalRankFusion(
          perVariant.map((ids, variantIndex) => ({
            ids,
            weight: plan.variants[variantIndex]?.weight ?? 0.6,
          })),
        ),
      );
    }
  }

  const hybrid = reciprocalRankFusion([
    { ids: lexicalIds, weight: 1 },
    ...(vectorIds.length ? [{ ids: vectorIds, weight: 0.92 }] : []),
  ]);
  const lexicalRank = rankMap(lexicalIds);
  const vectorRank = rankMap(vectorIds);

  const fusedCandidates: RetrievedSource[] = [];
  for (const [id, score] of hybrid.entries()) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    fusedCandidates.push({
      ...chunk,
      score,
      recall: {
        lexicalRank: lexicalRank.get(id),
        vectorRank: vectorRank.get(id),
      },
    });
  }
  fusedCandidates.sort((a, b) => b.score - a.score);

  const graphSlots = useGraph ? Math.min(limit, plan.intent === "comparison" ? 4 : 2) : 0;
  const preLimit = Math.max(1, limit - graphSlots);
  const base: RetrievedSource[] = [];
  const seenSection = new Set<string>();
  for (const source of fusedCandidates) {
    const sectionKey = `${source.paperId}|${source.section}`;
    if (source.section !== "relation" && seenSection.has(sectionKey)) continue;
    // 问题点名了论文时,只保留与这些论文相连的块;否则「基线」这种通用词
    // 会把别的论文整段拉进来,看似召回很多,其实答非所问。
    if (
      plan.mentionedPaperIds.length > 0 &&
      !source.paperIds.some((id) => plan.mentionedPaperIds.includes(id))
    ) {
      continue;
    }
    seenSection.add(sectionKey);
    base.push(source);
    if (base.length >= preLimit) break;
  }

  const topBaseScore = base[0]?.score ?? 0;
  const bridged = useGraph
    ? graphRelations(
        chunks,
        base,
        plan.mentionedPaperIds,
        limit - base.length + graphSlots,
        plan.intent,
        topBaseScore * 0.55,
      )
    : [];

  const candidates = [...base, ...bridged];
  const tokens = conceptTokens(plan.original);
  const ranked = rerank(candidates, plan, tokens);
  const sources = ensureCoverage(ranked, plan, limit);

  const finalCoverage = coverageOf(
    tokens,
    sources.map((source) => `${source.title} ${source.text}`),
  );
  const normalizedTop = ranked[0]?.score ?? 0;
  const confidence = Math.min(1, finalCoverage * 0.65 + normalizedTop * 0.35);
  const missingPaperIds = plan.mentionedPaperIds.filter(
    (id) => !sources.some((source) => source.paperIds.includes(id)),
  );
  const threshold = 0.38;
  const enough =
    sources.length >= 2 &&
    finalCoverage >= 0.28 &&
    missingPaperIds.length === 0 &&
    confidence >= threshold;

  return {
    sources,
    diagnostics: {
      intent: plan.intent,
      mode: vectorIds.length ? "hybrid" : "lexical",
      queryVariants: plan.variants.map((variant) => variant.text),
      lexicalHits: lexicalIds.length,
      vectorHits: vectorIds.length,
      graphRelations: sources.filter((source) => source.recall?.graph).length,
      sourceCount: sources.length,
      coverage: Number(finalCoverage.toFixed(3)),
      topScore: Number(normalizedTop.toFixed(3)),
      threshold,
      enough,
      mentionedPapers: plan.mentionedPaperIds.length,
      missingPaperIds,
    },
  };
}

/** 兼容只需要证据块的调用方。需要停止判定与召回诊断时用 detailed 版本。 */
export async function retrieveSources(
  payload: StarfieldPayload,
  question: string,
  limit = 8,
  options: RetrievalOptions = {},
): Promise<RetrievedSource[]> {
  return (await retrieveSourcesDetailed(payload, question, limit, options)).sources;
}
