"use client";

import { useCallback, useEffect, useState } from "react";

import type { AskSource, AskSuggestion } from "@/types/rag";

export interface AskHistoryEntry {
  id: string;
  createdAt: number;
  question: string;
  answer: string;
  sources: AskSource[];
  citations: number[];
  suggestions: AskSuggestion[];
  fallback: boolean;
}

type NewAskHistoryEntry = Omit<AskHistoryEntry, "id" | "createdAt">;

const STORAGE_PREFIX = "stellarlit:ask-history:v1:";
const MAX_ENTRIES = 30;

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
    typeof value.fallback === "boolean"
  );
}

function loadHistory(starfieldId: string): AskHistoryEntry[] {
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

function persistHistory(starfieldId: string, history: AskHistoryEntry[]): void {
  try {
    localStorage.setItem(storageKey(starfieldId), JSON.stringify(history));
  } catch {
    // 存储空间不足或隐私模式禁止写入时,当前页面内的历史仍然可用
  }
}

/** 每片星空独立保存问答历史,避免不同图谱的引用编号混在一起。 */
export function useAskHistory(starfieldId: string) {
  const [history, setHistory] = useState<AskHistoryEntry[]>([]);

  useEffect(() => {
    setHistory(loadHistory(starfieldId));
  }, [starfieldId]);

  const add = useCallback(
    (entry: NewAskHistoryEntry) => {
      setHistory((current) => {
        const now = Date.now();
        const next: AskHistoryEntry[] = [
          {
            ...entry,
            id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: now,
          },
          ...current,
        ].slice(0, MAX_ENTRIES);
        persistHistory(starfieldId, next);
        return next;
      });
    },
    [starfieldId],
  );

  return { history, add };
}
