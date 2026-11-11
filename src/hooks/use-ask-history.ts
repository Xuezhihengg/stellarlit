"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearAskHistory,
  fetchAskHistory,
  fetchAskHistoryEntry,
  saveAskHistory,
} from "@/lib/api/client";
import type {
  AskDecision,
  AskHistoryEntry,
  AskHistorySummary,
  AskSource,
  AskStep,
  AskSuggestion,
  ImageEvidence,
} from "@/types/rag";

export type { AskHistoryEntry, AskHistorySummary };

type NewAskHistoryEntry = Omit<AskHistoryEntry, "id" | "createdAt">;

const STORAGE_PREFIX = "stellarlit:ask-history:v2:";
/** 旧版键里存的是 360px base64,30 条能撑爆 localStorage;读到就清掉。 */
const LEGACY_PREFIX = "stellarlit:ask-history:v1:";
const MAX_ENTRIES = 30;
const SUMMARY_ANSWER_CHARS = 280;

function storageKey(starfieldId: string): string {
  return `${STORAGE_PREFIX}${starfieldId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAskSource(value: unknown): value is AskSource {
  return (
    isRecord(value) &&
    typeof value.n === "number" &&
    typeof value.chunkId === "string" &&
    typeof value.paperId === "string" &&
    Array.isArray(value.paperIds) &&
    value.paperIds.every((id) => typeof id === "string") &&
    typeof value.title === "string" &&
    (value.section === "title" ||
      value.section === "abstract" ||
      value.section === "relation") &&
    typeof value.quote === "string" &&
    (value.year === undefined || typeof value.year === "number")
  );
}

function isSuggestion(value: unknown): value is AskSuggestion {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    (value.year === undefined || typeof value.year === "number") &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isAskStep(value: unknown): value is AskStep {
  return (
    isRecord(value) &&
    typeof value.slot === "number" &&
    typeof value.round === "number" &&
    typeof value.tool === "string" &&
    typeof value.label === "string" &&
    (value.state === "running" ||
      value.state === "done" ||
      value.state === "empty" ||
      value.state === "failed") &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.why === undefined || typeof value.why === "string")
  );
}

function isImageEvidence(value: unknown): value is ImageEvidence {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.imageIndex === "number" &&
    typeof value.label === "string" &&
    (value.kind === "caption" ||
      value.kind === "ocr" ||
      value.kind === "chart" ||
      value.kind === "table" ||
      value.kind === "numeric" ||
      value.kind === "trend") &&
    typeof value.title === "string" &&
    typeof value.quote === "string" &&
    Array.isArray(value.numbers) &&
    value.numbers.every((number) => typeof number === "string") &&
    (value.region === undefined ||
      (isRecord(value.region) &&
        typeof value.region.x === "number" &&
        typeof value.region.y === "number" &&
        typeof value.region.width === "number" &&
        typeof value.region.height === "number"))
  );
}

function isAskDecision(value: unknown): value is AskDecision {
  return (
    isRecord(value) &&
    typeof value.round === "number" &&
    (value.action === "continue" || value.action === "stop") &&
    (value.code === "enough" ||
      value.code === "continue" ||
      value.code === "no_new_evidence" ||
      value.code === "max_rounds" ||
      value.code === "max_steps" ||
      value.code === "no_more_tools") &&
    typeof value.reason === "string" &&
    Array.isArray(value.gaps) &&
    value.gaps.every((gap) => typeof gap === "string") &&
    isRecord(value.stats) &&
    typeof value.stats.sources === "number" &&
    typeof value.stats.relations === "number" &&
    typeof value.stats.papers === "number" &&
    typeof value.stats.external === "number"
  );
}

function isHistoryEntry(value: unknown): value is AskHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    Array.isArray(value.sources) &&
    value.sources.every(isAskSource) &&
    Array.isArray(value.citations) &&
    value.citations.every((n) => typeof n === "number") &&
    Array.isArray(value.suggestions) &&
    value.suggestions.every(isSuggestion) &&
    typeof value.fallback === "boolean" &&
    (value.imageCount === undefined || typeof value.imageCount === "number") &&
    (value.imageEvidence === undefined ||
      (Array.isArray(value.imageEvidence) &&
        value.imageEvidence.every(isImageEvidence))) &&
    (value.imagePreviews === undefined ||
      (Array.isArray(value.imagePreviews) &&
        value.imagePreviews.every((preview) => typeof preview === "string"))) &&
    (value.trace === undefined ||
      (Array.isArray(value.trace) && value.trace.every(isAskStep))) &&
    (value.decisions === undefined ||
      (Array.isArray(value.decisions) && value.decisions.every(isAskDecision)))
  );
}

function summaryOf(entry: AskHistoryEntry): AskHistorySummary {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    question: entry.question,
    answer: entry.answer.slice(0, SUMMARY_ANSWER_CHARS),
    imageCount: entry.imagePreviews?.length || entry.imageCount,
  };
}

/** localStorage 只存文本详情;图片预览是对象 URL,不应该再复制一份 base64。 */
function forStorage(entry: AskHistoryEntry): AskHistoryEntry {
  return { ...entry, imagePreviews: undefined };
}

function loadCached(starfieldId: string): AskHistoryEntry[] {
  try {
    // 旧版每条历史带 4 张 base64 预览,可能占满配额;一次性清掉所有旧键
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // 隐私模式
  }
  try {
    const raw = localStorage.getItem(storageKey(starfieldId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry).slice(0, MAX_ENTRIES);
  } catch {
    // 旧版本损坏或隐私模式不可读时,不影响当前问答
    return [];
  }
}

function persistCached(starfieldId: string, entries: AskHistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(starfieldId), JSON.stringify(entries.map(forStorage)));
  } catch {
    // 存储空间不足或隐私模式禁止写入时,当前页面内的历史仍然可用
  }
}

/**
 * 每片星空独立保存问答历史,避免不同图谱的引用编号混在一起。
 *
 * 列表只取摘要(问题 / 回答前 280 字 / 图片数量),详情在点开时按 id 取;
 * 本地仍保留一份文本详情用于秒开,图片预览则统一由服务端对象提供。
 */
export function useAskHistory(starfieldId: string) {
  const [history, setHistory] = useState<AskHistorySummary[]>([]);
  /** 已经完成水合的 starfieldId:防止切换星空时把上一片的历史写进新 key。 */
  const hydratedFor = useRef<string | null>(null);
  /** 完整详情缓存:本会话新建的直接命中,老记录按需从服务端取。 */
  const details = useRef<Map<string, AskHistoryEntry>>(new Map());

  useEffect(() => {
    let cancelled = false;
    hydratedFor.current = null;
    details.current.clear();
    const cached = loadCached(starfieldId);
    for (const entry of cached) details.current.set(entry.id, entry);
    setHistory(cached.map(summaryOf));
    hydratedFor.current = starfieldId;

    void fetchAskHistory(starfieldId)
      .then((remote) => {
        if (cancelled) return;
        setHistory((current) => {
          const byId = new Map<string, AskHistorySummary>();
          for (const item of current) byId.set(item.id, item);
          // 服务端是主副本;同一条记录以服务端摘要为准
          for (const item of remote) byId.set(item.id, item);
          return [...byId.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_ENTRIES);
        });
      })
      .catch(() => {
        // 服务端不可用时继续用本地缓存,不影响当前问答
      });

    return () => {
      cancelled = true;
    };
  }, [starfieldId]);

  // 只在读取完成后回写本地缓存,避免把刚清空的内存状态当成「没有历史」覆盖掉缓存。
  useEffect(() => {
    if (hydratedFor.current !== starfieldId) return;
    const cached = history
      .map((item) => details.current.get(item.id))
      .filter((entry): entry is AskHistoryEntry => Boolean(entry));
    persistCached(starfieldId, cached);
  }, [history, starfieldId]);

  const add = useCallback(
    (entry: NewAskHistoryEntry) => {
      const now = Date.now();
      const record: AskHistoryEntry = {
        ...entry,
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
      };
      details.current.set(record.id, record);
      const summary = summaryOf(record);
      setHistory((current) => [summary, ...current.filter((item) => item.id !== record.id)].slice(0, MAX_ENTRIES));
      // 落库失败只影响「换设备还能不能看到」,不影响本次回答
      void saveAskHistory(starfieldId, record).catch(() => undefined);
    },
    [starfieldId],
  );

  /** 回放前取完整详情;本会话新建的历史直接命中内存。 */
  const resolve = useCallback(
    async (id: string): Promise<AskHistoryEntry | null> => {
      const cached = details.current.get(id);
      if (cached) return cached;
      try {
        const remote = await fetchAskHistoryEntry(starfieldId, id);
        details.current.set(remote.id, remote);
        return remote;
      } catch {
        return null;
      }
    },
    [starfieldId],
  );

  const clear = useCallback(() => {
    details.current.clear();
    setHistory([]);
    try {
      localStorage.removeItem(storageKey(starfieldId));
    } catch {
      // 隐私模式
    }
    void clearAskHistory(starfieldId).catch(() => undefined);
  }, [starfieldId]);

  return { history, add, clear, resolve };
}
