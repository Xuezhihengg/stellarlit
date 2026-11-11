/**
 * 向量召回 —— 只负责「文本 → 单位向量」,不参与排序。
 *
 * 供应商走 OpenAI 兼容的 `/embeddings` 接口。任何失败都返回 null:
 * 检索不能因为向量模型没配额就整个不可用,词面检索仍然是可靠底座。
 * 向量会按「供应商 + 文本」缓存;同一片星空重复提问不会重复付费。
 */

import { createHash } from "node:crypto";

import { l2Normalize } from "@/lib/rag/hybrid";
import { recordUsage } from "@/server/db/usage";
import {
  resolveAccountCredentials,
  resolveEmbeddingTarget,
} from "@/server/model-settings";

export interface EmbeddingProvider {
  /** 缓存分区键,不能包含密钥。 */
  id: string;
  embed: (texts: string[]) => Promise<number[][] | null>;
}

const CACHE_LIMIT = 4096;
const vectorCache = new Map<string, number[]>();

function cacheKey(providerId: string, text: string): string {
  return `${providerId}:${createHash("sha1").update(text).digest("hex")}`;
}

function remember(key: string, vector: number[]): void {
  if (vectorCache.size >= CACHE_LIMIT) {
    const oldest = vectorCache.keys().next().value;
    if (oldest) vectorCache.delete(oldest);
  }
  vectorCache.set(key, vector);
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  embeddings?: number[][];
}

async function requestBatch(
  baseUrl: string,
  apiKey: string,
  model: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][] | null> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts.map((text) => text.slice(0, 8_000)),
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as EmbeddingResponse;
    const rows = data.data?.map((item) => item.embedding) ?? data.embeddings;
    if (!rows || rows.length !== texts.length) return null;
    if (rows.some((row) => !Array.isArray(row) || !row.length)) return null;
    return rows as number[][];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function defaultEmbeddingProvider(
  ownerId: string,
  signal?: AbortSignal,
): Promise<EmbeddingProvider | null> {
  const target = await resolveEmbeddingTarget(ownerId);
  if (!target) return null;
  const id = `${target.baseUrl}|${target.model}`;

  return {
    id,
    async embed(texts) {
      if (!texts.length) return [];
      const out: number[][] = [];
      const missing: Array<{ index: number; text: string }> = [];

      for (const [index, text] of texts.entries()) {
        const hit = vectorCache.get(cacheKey(id, text));
        if (hit) out[index] = hit;
        else missing.push({ index, text });
      }

      const BATCH = 48;
      let spent = 0;
      for (let cursor = 0; cursor < missing.length; cursor += BATCH) {
        const batch = missing.slice(cursor, cursor + BATCH);
        spent += batch.reduce((sum, item) => sum + Math.ceil(item.text.length / 2), 0);
        const vectors = await requestBatch(
          target.baseUrl,
          target.apiKey,
          target.model,
          batch.map((item) => item.text),
          signal,
        );
        if (!vectors) {
          await recordUsage(ownerId, spent).catch(() => undefined);
          return null;
        }
        for (const [offset, vector] of vectors.entries()) {
          const item = batch[offset]!;
          const unit = l2Normalize(vector);
          out[item.index] = unit;
          remember(cacheKey(id, item.text), unit);
        }
      }

      if (spent > 0) await recordUsage(ownerId, spent).catch(() => undefined);
      return out.every((row) => Array.isArray(row) && row.length > 0) ? out : null;
    },
  };
}

export interface EmbeddingHealth {
  ok: boolean;
  dimensions?: number;
  latencyMs?: number;
  error?: string;
}

/** 设置页的「测试向量」:真的请求一次 embeddings,而不是只测 /models。 */
export async function probeEmbedding(ownerId: string, input: {
  accountId: string;
  model: string;
}): Promise<EmbeddingHealth> {
  const account = await resolveAccountCredentials(ownerId, input.accountId);
  if (!account) return { ok: false, error: "服务商不存在或还没有保存 API Key" };
  if (!input.model.trim()) return { ok: false, error: "请填写向量模型 ID" };

  const startedAt = Date.now();
  const probeText = "StellarLit embedding connectivity check";
  const vectors = await requestBatch(
    account.baseUrl,
    account.apiKey,
    input.model.trim(),
    [probeText],
  );
  await recordUsage(ownerId, Math.ceil(probeText.length / 2)).catch(() => undefined);
  if (!vectors?.length) {
    return {
      ok: false,
      error: "向量接口没有返回结果,请检查模型 ID 与服务商是否支持 /embeddings",
    };
  }
  return {
    ok: true,
    dimensions: vectors[0]!.length,
    latencyMs: Date.now() - startedAt,
  };
}
