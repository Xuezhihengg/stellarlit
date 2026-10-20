"use client";

import { useEffect, useRef, useState } from "react";

import { Collapsible } from "@/components/ui/Collapsible";
import { useAskHistory, type AskHistoryEntry } from "@/hooks/use-ask-history";
import { askStarfield } from "@/lib/api/client";
import type { StarfieldPayload } from "@/types/api";
import type { AskSource, AskSuggestion } from "@/types/rag";

interface AskPanelProps {
  payload: StarfieldPayload;
  /** 点依据:单篇就聚焦单篇,关系卡则把两篇一起放进镜头 */
  onFocusSource: (source: AskSource) => void;
  /** 把回答里发现的新论文交给"解析 → 用户确认 → 并入"的既有流程 */
  onAddPaper: (title: string) => void;
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
export function AskPanel({ payload, onFocusSource, onAddPaper }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AskSource[]>([]);
  const [citations, setCitations] = useState<number[]>([]);
  const [suggestions, setSuggestions] = useState<AskSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [replayedAnswer, setReplayedAnswer] = useState<{
    createdAt: number;
    nonce: number;
  } | null>(null);
  const { history, add: addHistory } = useAskHistory(payload.starfield.id);
  const abortRef = useRef<AbortController | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const replayNonceRef = useRef(0);
  /** 角标 → 依据卡片:点击角标时滚到那张卡并高亮 */
  const sourceRefs = useRef(new Map<number, HTMLLIElement | null>());

  // 问答和引用编号只对当前星空有意义,换星空时不能把上一份答案带过去
  useEffect(() => {
    abortRef.current?.abort();
    setQuestion("");
    setAnswer("");
    setSources([]);
    setCitations([]);
    setSuggestions([]);
    setBusy(false);
    setFallback(false);
    setError(null);
    setActiveCitation(null);
    setHistoryOpen(false);
    setReplayedAnswer(null);
  }, [payload.starfield.id]);

  // 最新记录放在底部:每次展开历史都直接定位到今天最关心的一条
  useEffect(() => {
    if (!historyOpen) return;
    const frame = requestAnimationFrame(() => {
      const list = historyListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [historyOpen, history.length]);

  const submit = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    let answerText = "";
    let receivedSources: AskSource[] = [];

    setBusy(true);
    setAnswer("");
    setSources([]);
    setCitations([]);
    setSuggestions([]);
    setFallback(false);
    setError(null);
    setActiveCitation(null);
    setHistoryOpen(false);
    setReplayedAnswer(null);

    void askStarfield(
      { starfieldId: payload.starfield.id, question: q },
      {
        onSources: (nextSources) => {
          if (ac.signal.aborted) return;
          receivedSources = nextSources;
          setSources(nextSources);
        },
        onDelta: (delta) => {
          if (ac.signal.aborted) return;
          answerText += delta;
          setAnswer(answerText);
        },
        onDone: (cited, isFallback, found) => {
          if (ac.signal.aborted) return;
          setCitations(cited);
          setFallback(isFallback);
          setSuggestions(found);
          setBusy(false);
          if (answerText.trim()) {
            addHistory({
              question: q,
              answer: answerText,
              sources: receivedSources,
              citations: cited,
              suggestions: found,
              fallback: isFallback,
            });
          }
        },
        onError: (message) => {
          if (ac.signal.aborted) return;
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
  const orderedHistory = [...history].reverse();

  const showHistoryEntry = (entry: AskHistoryEntry) => {
    abortRef.current?.abort();
    replayNonceRef.current += 1;
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setSources(entry.sources);
    setCitations(entry.citations);
    setSuggestions(entry.suggestions);
    setFallback(entry.fallback);
    setError(null);
    setActiveCitation(null);
    setBusy(false);
    setHistoryOpen(false);
    setReplayedAnswer({
      createdAt: entry.createdAt,
      nonce: replayNonceRef.current,
    });
  };

  /** 点 [n]:聚焦对应论文,并把那张依据卡滚进视野、标亮 */
  const cite = (n: number) => {
    const source = sources.find((s) => s.n === n);
    if (!source) return;
    setActiveCitation(n);
    onFocusSource(source);
    sourceRefs.current.get(n)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <section className="rounded-xl border border-hair bg-hair/15 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">
          检索增强问答
        </span>
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-expanded={historyOpen}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink-2"
        >
          历史问答
          {history.length ? (
            <span className="font-mono text-[9px] text-ink-4">{history.length}</span>
          ) : null}
          <svg
            width="8"
            height="8"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={`transition-transform duration-[var(--dur-fast)] ${historyOpen ? "rotate-180" : ""}`}
            style={{ transitionTimingFunction: "var(--ease-out)" }}
          >
            <path
              d="M2 3.8 L5 6.6 L8 3.8"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <Collapsible open={historyOpen} className="mb-2">
        <div
          ref={historyListRef}
          className="max-h-60 overflow-y-auto rounded-lg border border-hair bg-bg/35"
        >
          {history.length ? (
            <ul className="divide-y divide-hair">
              {orderedHistory.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => showHistoryEntry(entry)}
                    aria-label={`查看历史问答:${entry.question}`}
                    className="w-full px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hair/35"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 text-[10.5px] leading-relaxed text-ink-2">
                        {entry.question}
                      </span>
                      <time
                        dateTime={new Date(entry.createdAt).toISOString()}
                        className="shrink-0 font-mono text-[9px] text-ink-4"
                      >
                        {formatHistoryTime(entry.createdAt)}
                      </time>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[9.5px] leading-relaxed text-ink-4">
                      {entry.answer}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-3 text-[10.5px] text-ink-4">
              还没有历史问答。完成一次提问后会保存在这里。
            </p>
          )}
        </div>
      </Collapsible>

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
        <div
          key={replayedAnswer ? `history-${replayedAnswer.nonce}` : "live-answer"}
          className={`mt-3 border-t border-hair pt-2.5 ${
            replayedAnswer ? "ask-answer-enter" : ""
          }`}
        >
          {replayedAnswer ? (
            <p className="mb-1.5 font-mono text-[9px] tracking-[0.1em] text-ink-4">
              历史回答 · {formatHistoryTime(replayedAnswer.createdAt)}
            </p>
          ) : null}
          {fallback ? (
            <p className="mb-1.5 font-mono text-[9.5px] text-warm">模型不可用 · 以下为检索原文</p>
          ) : null}
          <p className="text-[12px] leading-[1.75] whitespace-pre-wrap text-ink-2">
            {renderWithCitations(plainText(answer), cite)}
          </p>

          {shownSources.length ? (
            <ul className="mt-2.5 flex flex-col gap-1">
              {shownSources.map((s) => (
                <li
                  key={s.chunkId}
                  ref={(el) => {
                    sourceRefs.current.set(s.n, el);
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onFocusSource(s)}
                    className={`w-full rounded-md border px-1.5 py-1 text-left transition-colors duration-[var(--dur-fast)] ${
                      activeCitation === s.n
                        ? "border-accent/35 bg-accent/10"
                        : "border-transparent hover:bg-hair/40"
                    }`}
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

          {suggestions.length ? (
            <div className="mt-3 border-t border-hair pt-2.5">
              <p className="m-0 text-[10px] tracking-[0.1em] text-ink-4">
                回答里提到、星空里还没有的论文 · 确认后加入
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {suggestions.map((s) => (
                  <li
                    key={`${s.title}-${s.year ?? ""}`}
                    className="flex items-start justify-between gap-2 rounded-md bg-hair/20 px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="text-[10.5px] leading-snug text-ink-2">
                        {s.title}
                        {s.year ? (
                          <span className="ml-1.5 font-mono text-[9.5px] text-ink-4">
                            {s.year}
                          </span>
                        ) : null}
                      </p>
                      {s.reason ? (
                        <p className="mt-0.5 line-clamp-1 text-[9.5px] text-ink-4">{s.reason}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => onAddPaper(s.title)}
                      className="shrink-0 rounded-md border border-hair-2 px-1.5 py-0.5 text-[9.5px] text-accent transition-colors duration-[var(--dur-fast)] hover:border-accent/40 hover:text-accent/80"
                    >
                      加入星空
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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

function formatHistoryTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

/**
 * 回答是纯文本渲染:模型偶尔仍会带 ** 加粗或 # 标题,
 * 在这里去掉标记本身,而不是把星号原样给用户看。
 */
function plainText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/gm, "");
}

/** 把 [1][3] 渲染成可点击的小角标:聚焦论文 + 滚到对应依据卡。 */
function renderWithCitations(text: string, onCite: (n: number) => void): React.ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = /^\[(\d+)\]$/.exec(part);
    if (!m) return part;
    const n = Number(m[1]);
    return (
      <button
        key={i}
        type="button"
        onClick={() => onCite(n)}
        aria-label={`查看依据 ${n}`}
        className="mx-0.5 -translate-y-0.5 rounded bg-accent/15 px-1 font-mono text-[9px] leading-none text-accent/90 transition-colors duration-[var(--dur-fast)] hover:bg-accent/25 hover:text-accent"
      >
        {n}
      </button>
    );
  });
}
