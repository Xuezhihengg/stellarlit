"use client";

import { useRef, useState } from "react";

import { askStarfield } from "@/lib/api/client";
import type { StarfieldPayload } from "@/types/api";
import type { AskSource } from "@/types/rag";

interface AskPanelProps {
  payload: StarfieldPayload;
  onFocusPaper: (id: string) => void;
}

const SUGGESTIONS = [
  "这几篇论文的研究脉络是什么?",
  "哪篇工作是其他方法的基线?",
  "它们之间有哪些同任务但不同路线的工作?",
];

/**
 * 检索增强问答。
 *
 * 交互顺序是刻意的:**先出依据,再出答案**。sources 事件比第一个 delta 早到,
 * 所以用户在看到第一句回答之前就知道"它查了哪些论文、哪些段落"——
 * 这让回答从"模型说的"变成"有出处的"。
 */
export function AskPanel({ payload, onFocusPaper }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AskSource[]>([]);
  const [citations, setCitations] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setBusy(true);
    setAnswer("");
    setSources([]);
    setCitations([]);
    setFallback(false);
    setError(null);

    void askStarfield(
      { starfieldId: payload.starfield.id, question: q },
      {
        onSources: setSources,
        onDelta: (delta) => setAnswer((prev) => prev + delta),
        onDone: (cited, isFallback) => {
          setCitations(cited);
          setFallback(isFallback);
          setBusy(false);
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
        },
      },
      ac.signal,
    );
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const citedSources = citations
    .map((n) => sources.find((s) => s.n === n))
    .filter((s): s is AskSource => Boolean(s));
  const shownSources = citedSources.length ? citedSources : sources.slice(0, 4);

  return (
    <section className="rounded-xl border border-hair bg-hair/15 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">检索问答</span>
        <span className="font-mono text-[9.5px] text-ink-4">
          {payload.graph.stats.papers} 篇 · 摘要 + 关系证据
        </span>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-hair-2 bg-bg/40 px-2.5 py-1.5 focus-within:border-accent/45">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(question);
            }
          }}
          placeholder="问关于这片星空的问题…"
          aria-label="关于星空的提问"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="shrink-0 rounded-md px-2 py-1 text-[10.5px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink-2"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => submit(question)}
            disabled={!question.trim()}
            aria-label="提问"
            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-accent transition-colors duration-[var(--dur-fast)] hover:text-accent/80 disabled:text-ink-4"
          >
            提问 ↵
          </button>
        )}
      </div>

      {!answer && !busy ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                submit(s);
              }}
              className="rounded-full border border-hair px-2 py-1 text-[10px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:border-hair-2 hover:text-ink-2"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-alert">{error}</p>
      ) : null}

      {answer ? (
        <div className="mt-3 border-t border-hair pt-2.5">
          {fallback ? (
            <p className="mb-1.5 font-mono text-[9.5px] text-warm">模型不可用 · 以下为检索原文</p>
          ) : null}
          <p className="text-[12px] leading-[1.75] whitespace-pre-wrap text-ink-2">
            {renderWithCitations(answer)}
          </p>

          {shownSources.length ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {shownSources.map((s) => (
                <li key={s.chunkId}>
                  <button
                    type="button"
                    onClick={() => onFocusPaper(s.paperId)}
                    className="w-full rounded-md px-1.5 py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hair/40"
                  >
                    <span className="mr-1.5 font-mono text-[9.5px] text-accent/80">[{s.n}]</span>
                    <span className="text-[10.5px] text-ink-3">
                      《{s.title}》· {sectionLabel(s.section)}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-relaxed text-ink-4">
                      {s.quote}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function sectionLabel(section: AskSource["section"]): string {
  if (section === "relation") return "关系证据";
  if (section === "title") return "论文信息";
  return "摘要";
}

/** 把 [1][3] 渲染成不可点的小角标;点击整条来源去定位论文。 */
function renderWithCitations(text: string): React.ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (!m) return part;
    return (
      <sup
        key={i}
        className="mx-0.5 rounded bg-accent/15 px-1 font-mono text-[9px] text-accent/90"
      >
        {m[1]}
      </sup>
    );
  });
}
