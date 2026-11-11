"use client";

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";

import { AgentTrace } from "@/components/shell/AgentTrace";
import { Collapsible } from "@/components/ui/Collapsible";
import { Modal } from "@/components/ui/Modal";
import {
  useAskHistory,
  type AskHistorySummary,
} from "@/hooks/use-ask-history";
import { askStarfield } from "@/lib/api/client";
import { formatPaperText, formatPaperTitle } from "@/lib/format";
import type { StarfieldPayload } from "@/types/api";
import {
  MAX_ASK_IMAGES,
  type AskDecision,
  type AskImage,
  type AskSource,
  type AskStep,
  type AskSuggestion,
  type ImageEvidence,
  type ImageRegion,
} from "@/types/rag";

interface AskPanelProps {
  payload: StarfieldPayload;
  /** 点依据:单篇就聚焦单篇,关系卡则把两篇一起放进镜头 */
  onFocusSource: (source: AskSource) => void;
  /** 把回答里发现的新论文交给"解析 → 用户确认 → 并入"的既有流程 */
  onAddPaper: (title: string) => void;
}

/** 待发送的图片:多一个稳定 id,进出场动画才不会因为重新排序而重播 */
interface PendingImage extends AskImage {
  id: string;
  /** 压缩预览只用于历史回放,当前会话查看原图仍然用完整 data URL */
  preview: string;
}

interface AnswerImage {
  name: string;
  src: string;
}

interface ImageViewerState {
  src?: string;
  label: string;
  kind: ImageEvidence["kind"];
  title: string;
  quote: string;
  numbers: string[];
  region?: ImageRegion;
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
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [trace, setTrace] = useState<AskStep[]>([]);
  const [decisions, setDecisions] = useState<AskDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [answerImages, setAnswerImages] = useState<AnswerImage[]>([]);
  const [imageEvidence, setImageEvidence] = useState<ImageEvidence[]>([]);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);
  const [leavingIds, setLeavingIds] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [replayedAnswer, setReplayedAnswer] = useState<{
    createdAt: number;
    nonce: number;
  } | null>(null);
  const {
    history,
    add: addHistory,
    clear: clearHistory,
    resolve: resolveHistoryEntry,
  } = useAskHistory(payload.starfield.id);
  const abortRef = useRef<AbortController | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef<PendingImage[]>([]);
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
    setFallbackReason(null);
    setTrace([]);
    setDecisions([]);
    setError(null);
    setActiveCitation(null);
    setHistoryOpen(false);
    setReplayedAnswer(null);
    setImages([]);
    setAnswerImages([]);
    setImageEvidence([]);
    setImageViewer(null);
    setLeavingIds([]);
    setImageError(null);
    setImageLoading(false);
    setDragging(false);
  }, [payload.starfield.id]);

  // 读图是异步的,连续粘贴/拖入时用它拿到"此刻已选几张",避免闭包里的旧值
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

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
    let receivedTrace: AskStep[] = [];
    let receivedDecisions: AskDecision[] = [];
    let receivedImageEvidence: ImageEvidence[] = [];
    // 正在播放退场动画的那张不算数:点掉后立刻回车也不该把它发出去
    const attached = images.filter((image) => !leavingIds.includes(image.id));
    const answerImageSnapshot = attached.map((image) => ({
      name: image.name,
      src: `data:${image.mimeType};base64,${image.data}`,
      preview: image.preview,
    }));

    setBusy(true);
    setAnswer("");
    setSources([]);
    setAnswerImages(answerImageSnapshot.map(({ name, src }) => ({ name, src })));
    setImageEvidence([]);
    setImageViewer(null);
    setCitations([]);
    setSuggestions([]);
    setFallback(false);
    setFallbackReason(null);
    setTrace([]);
    setDecisions([]);
    setError(null);
    setActiveCitation(null);
    setHistoryOpen(false);
    setReplayedAnswer(null);

    void askStarfield(
      {
        starfieldId: payload.starfield.id,
        question: q,
        images: attached.length
          ? attached.map(({ mimeType, data, name }) => ({ mimeType, data, name }))
          : undefined,
      },
      {
        onSources: (nextSources) => {
          if (ac.signal.aborted) return;
          receivedSources = nextSources;
          setSources(nextSources);
        },
        onImageEvidence: (evidence) => {
          if (ac.signal.aborted) return;
          receivedImageEvidence = evidence;
          setImageEvidence(evidence);
        },
        onActivity: (step) => {
          if (ac.signal.aborted) return;
          // 同一步先 running 后 done:按 slot 原地替换,而不是追加两条
          const index = receivedTrace.findIndex((item) => item.slot === step.slot);
          if (index < 0) receivedTrace = [...receivedTrace, step];
          else receivedTrace = receivedTrace.map((item, i) => (i === index ? step : item));
          setTrace(receivedTrace);
        },
        onDecision: (decision) => {
          if (ac.signal.aborted) return;
          receivedDecisions = [...receivedDecisions, decision];
          setDecisions(receivedDecisions);
        },
        onDelta: (delta) => {
          if (ac.signal.aborted) return;
          answerText += delta;
          setAnswer(answerText);
        },
        onDone: (cited, isFallback, found, reason) => {
          if (ac.signal.aborted) return;
          setCitations(cited);
          setFallback(isFallback);
          setFallbackReason(reason ?? null);
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
              imageCount: attached.length || undefined,
              imageEvidence: receivedImageEvidence.length
                ? receivedImageEvidence
                : undefined,
              imagePreviews: answerImageSnapshot.length
                ? answerImageSnapshot.map((image) => image.preview)
                : undefined,
              trace: receivedTrace,
              decisions: receivedDecisions,
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

  const showHistoryEntry = async (entry: AskHistorySummary) => {
    abortRef.current?.abort();
    const nonce = replayNonceRef.current + 1;
    replayNonceRef.current = nonce;
    setQuestion(entry.question);
    setAnswer("");
    setSources([]);
    setCitations([]);
    setSuggestions([]);
    setFallback(false);
    setFallbackReason(null);
    setTrace([]);
    setDecisions([]);
    setError(null);
    setActiveCitation(null);
    setBusy(false);
    setHistoryOpen(false);
    setImages([]);
    setAnswerImages([]);
    setImageEvidence([]);
    setImageViewer(null);
    setImageError(null);

    const full = await resolveHistoryEntry(entry.id);
    // 用户在等待期间又点了另一条:不要用旧结果覆盖
    if (replayNonceRef.current !== nonce) return;
    if (!full) {
      setError("这条历史读取失败,请稍后重试");
      return;
    }
    setAnswer(full.answer);
    setSources(full.sources);
    setCitations(full.citations);
    setSuggestions(full.suggestions);
    setFallback(full.fallback);
    setAnswerImages(
      (full.imagePreviews ?? []).map((src, index) => ({
        name: `图片 ${index + 1}`,
        src,
      })),
    );
    setImageEvidence(full.imageEvidence ?? []);
    setReplayedAnswer({
      createdAt: full.createdAt,
      nonce,
    });
    setTrace(full.trace ?? []);
    setDecisions(full.decisions ?? []);
  };

  /** 文件选择、粘贴、拖拽三条入口最终都汇到这里,统一校验与限流。 */
  const addImages = async (files: File[]) => {
    if (busy || !files.length) return;
    const picked = files.filter((file) => file.type.startsWith("image/"));
    if (!picked.length) {
      setImageError("只能添加图片文件");
      return;
    }

    setImageLoading(true);
    setImageError(null);
    try {
      const room = MAX_ASK_IMAGES - imagesRef.current.length;
      if (room <= 0) {
        setImageError(`最多添加 ${MAX_ASK_IMAGES} 张图片`);
        return;
      }
      const accepted = picked.slice(0, room);
      const next: PendingImage[] = [];
      for (const file of accepted) {
        next.push({ ...(await readAskImage(file)), id: crypto.randomUUID() });
      }
      setImages((prev) => [...prev, ...next].slice(0, MAX_ASK_IMAGES));
      if (picked.length > accepted.length) {
        setImageError(`最多添加 ${MAX_ASK_IMAGES} 张图片,多出的已忽略`);
      }
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "无法读取这张图片");
    } finally {
      setImageLoading(false);
    }
  };

  const removeImage = (id: string) => {
    setImageError(null);
    setLeavingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    // 与 CSS 里的退场时长保持一致,动画结束后再真正删除
    setTimeout(() => {
      setImages((prev) => prev.filter((image) => image.id !== id));
      setLeavingIds((prev) => prev.filter((item) => item !== id));
    }, 160);
  };

  /** 粘贴:截图工具复制到剪贴板后直接 Cmd+V。 */
  const pasteImages = (event: ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    void addImages(files);
  };

  /** 点 [n]:聚焦对应论文,并把那张依据卡滚进视野、标亮 */
  const cite = (n: number) => {
    const source = sources.find((s) => s.n === n);
    if (!source) return;
    setActiveCitation(n);
    onFocusSource(source);
    sourceRefs.current.get(n)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const openImageEvidence = (item: ImageEvidence) => {
    setImageViewer({
      src: answerImages[item.imageIndex]?.src,
      label: item.label,
      kind: item.kind,
      title: item.title,
      quote: item.quote,
      numbers: item.numbers,
      region: item.region,
    });
  };

  /** 模型偶尔只写 [图1];此时回退到该图排序最靠前的证据块。 */
  const citeImage = (label: string) => {
    const item =
      imageEvidence.find((evidence) => evidence.label === label) ??
      imageEvidence.find((evidence) => evidence.label.startsWith(`${label}-`));
    if (item) openImageEvidence(item);
  };

  /** 只在拖的是文件时接管;拖文字进来仍然走浏览器默认行为 */
  const dragHasFiles = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (!dragging) setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!dragging) return;
    // 在卡片内部移动也会触发 dragleave,且拖拽时 relatedTarget 恒为 null,
    // 所以按指针是否还在卡片范围内判断,避免蒙版一闪一闪。
    const rect = event.currentTarget.getBoundingClientRect();
    const { clientX, clientY } = event;
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return;
    }
    setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    void addImages(Array.from(event.dataTransfer.files));
  };

  return (
    <section
      className={`relative rounded-xl border bg-hair/15 p-3 transition-colors duration-[var(--dur-fast)] ${
        dragging ? "border-accent/45 bg-accent/5" : "border-hair"
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">
          检索增强问答
        </span>
        <div className="flex items-center gap-1">
          {historyOpen && history.length ? (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("清空这片星空的问答历史?服务端记录也会删除。")) clearHistory();
              }}
              className="rounded-md px-1.5 py-0.5 text-[10px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-alert"
            >
              清空
            </button>
          ) : null}
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
                    onClick={() => void showHistoryEntry(entry)}
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
                    {entry.imageCount ? (
                      <p className="mt-1 text-[9px] text-accent/70">
                        图表附件 · {entry.imageCount} 张
                      </p>
                    ) : null}
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

      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          void addImages(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      {/* 只留缩略图:文件名和"将随问题发送"对用户没有信息量,反而把输入区撑高 */}
      {images.length ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {images.map((image, index) => (
            <li
              key={image.id}
              className={`group relative h-14 w-14 overflow-hidden rounded-md border border-hair-2 bg-hair/30 ${
                leavingIds.includes(image.id) ? "ask-image-leave" : "ask-image-enter"
              }`}
            >
              <div
                role="img"
                aria-label={`待分析的图片 ${index + 1}`}
                className="h-full w-full bg-cover bg-center"
                style={{
                  backgroundImage: `url(data:${image.mimeType};base64,${image.data})`,
                }}
              />
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                aria-label={`移除第 ${index + 1} 张图片`}
                className="absolute inset-0 grid place-items-center bg-bg/70 text-alert opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 focus-visible:opacity-100"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3 3 L9 9 M9 3 L3 9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {imageError ? (
        <p className="mb-2 text-[10.5px] text-alert">{imageError}</p>
      ) : null}

      <div className="flex items-center gap-1.5 rounded-lg border border-hair-2 bg-bg/40 py-1.5 pr-2 pl-2.5 focus-within:border-accent/45">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPaste={pasteImages}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // 输入法用回车确认候选词时,这个回车不应该被当成发送
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault();
              submit(question);
            }
          }}
          placeholder="问关于这片星空的问题…"
          aria-label="关于星空的提问"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4"
        />
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          disabled={busy || imageLoading || images.length >= MAX_ASK_IMAGES}
          aria-label="添加图片"
          title="添加图片(也可以直接粘贴或拖入)"
          className={`shrink-0 rounded-md p-1 transition-colors duration-[var(--dur-fast)] disabled:opacity-30 ${
            images.length ? "text-accent/80 hover:text-accent" : "text-ink-4 hover:text-ink-2"
          }`}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none">
            <rect
              x="1.6"
              y="2.6"
              width="12.8"
              height="10.8"
              rx="2.2"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle cx="5.6" cy="6.1" r="1.15" stroke="currentColor" strokeWidth="1.1" />
            <path
              d="M2.8 11.9 L6.2 8.6 L8.9 11.2 L11.1 9.1 L13.2 11.1"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
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

      {busy || trace.length || decisions.length ? (
        <AgentTrace
          trace={trace}
          decisions={decisions}
          busy={busy}
          hasResult={Boolean(answer.trim())}
        />
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
          {fallbackReason ? (
            <p className="mb-1.5 text-[9.5px] leading-relaxed text-ink-4">原因:{fallbackReason}</p>
          ) : null}
          <p className="text-[12px] leading-[1.75] whitespace-pre-wrap text-ink-2">
            {renderWithCitations(plainText(answer), cite, citeImage)}
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
                      《{formatPaperTitle(s.title)}》· {sectionLabel(s.section)}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-relaxed text-ink-4">
                      {formatPaperText(s.quote)}
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
                        {formatPaperTitle(s.title)}
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
      <ImageEvidenceModal viewer={imageViewer} onClose={() => setImageViewer(null)} />
      {dragging ? (
        <div className="ask-drop-mask pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border border-accent/45 bg-bg/85">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-accent/40 text-accent">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
              <path
                d="M6 2.2 V9.8 M2.2 6 H9.8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="text-[11px] text-ink-2">
            {images.length >= MAX_ASK_IMAGES
              ? `最多 ${MAX_ASK_IMAGES} 张照片`
              : "松开即可添加照片"}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function ImageEvidenceModal({
  viewer,
  onClose,
}: {
  viewer: ImageViewerState | null;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<ImageViewerState | null>(viewer);
  useEffect(() => {
    if (viewer) setShown(viewer);
  }, [viewer]);
  const current = viewer ?? shown;

  return (
    <Modal
      open={Boolean(viewer)}
      onClose={onClose}
      label={current ? `图像证据 ${current.label}` : "图像证据"}
      className="max-w-[900px]"
    >
      {current ? (
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 font-mono text-[9px] tracking-[0.12em] text-accent/85">
                {current.label} · {imageEvidenceKindLabel(current.kind)}
              </p>
              <h2 className="mt-1 text-[15px] font-medium text-ink">{current.title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-[11px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink-2"
            >
              关闭
            </button>
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-hair bg-black/90">
            {current.src ? (
              <div className="relative mx-auto w-fit max-w-full overflow-hidden">
                {/* 原图来自用户本地,不走 Next 图片优化 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={current.src}
                  alt={current.title}
                  className="block max-h-[64dvh] max-w-full object-contain"
                />
                {current.region ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute rounded-sm border-2 border-accent bg-accent/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.34)]"
                    style={{
                      left: `${current.region.x * 100}%`,
                      top: `${current.region.y * 100}%`,
                      width: `${current.region.width * 100}%`,
                      height: `${current.region.height * 100}%`,
                    }}
                  />
                ) : null}
              </div>
            ) : (
              <p className="px-4 py-6 text-center text-[11px] text-ink-4">
                历史记录只保留了抽取文字,没有保存这张原图。
              </p>
            )}
          </div>

          <p className="mt-3 whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-3">
            {current.quote}
          </p>
          {current.numbers.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {current.numbers.map((number) => (
                <span
                  key={number}
                  className="rounded-md border border-hair bg-hair/30 px-1.5 py-0.5 font-mono text-[9px] text-ink-3"
                >
                  {number}
                </span>
              ))}
            </div>
          ) : null}
          <p className="mt-2 font-mono text-[8.5px] tracking-[0.08em] text-ink-4">
            {current.region ? "高亮区域即该证据在原图中的位置" : "该证据没有返回区域坐标"}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function sectionLabel(section: AskSource["section"]): string {
  if (section === "relation") return "关系证据";
  if (section === "title") return "论文信息";
  return "摘要";
}

function imageEvidenceKindLabel(kind: ImageEvidence["kind"]): string {
  if (kind === "ocr") return "OCR";
  if (kind === "chart") return "图表";
  if (kind === "trend") return "趋势";
  if (kind === "table") return "表格";
  if (kind === "numeric") return "数值";
  return "概述";
}

async function readAskImage(file: File): Promise<Omit<PendingImage, "id">> {
  const supported: AskImage["mimeType"][] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ];
  if (!supported.includes(file.type as AskImage["mimeType"])) {
    throw new Error("请选择 JPG、PNG、WebP 或 GIF 图片");
  }
  if (file.size > 4 * 1024 * 1024) {
    throw new Error("图片不能超过 4MB,请先压缩或裁剪");
  }
  const result = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法读取图片"));
    };
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
  const data = result.split(",", 2)[1];
  if (!data) throw new Error("图片内容为空");
  return {
    mimeType: file.type as AskImage["mimeType"],
    data,
    name: file.name.slice(0, 160),
    preview: await makeImagePreview(result),
  };
}

/** 历史只存小预览,避免把几张 4MB 原图反复写进 localStorage。 */
const FALLBACK_PREVIEW =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function makeImagePreview(dataUrl: string): Promise<string> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const max = 240;
    const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return FALLBACK_PREVIEW;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    // 预览只是历史回放的辅助信息,生成失败不应该让整次提问失败
    return FALLBACK_PREVIEW;
  }
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

/** 把 [1] 和 [图1-2] 都渲染成可点击角标:分别定位文字依据与图像区域。 */
function renderWithCitations(
  text: string,
  onCite: (n: number) => void,
  onImageCite: (label: string) => void,
): React.ReactNode[] {
  return text.split(/(\[(?:\d+|图\d+(?:-\d+)?)\])/g).map((part, i) => {
    const textMatch = /^\[(\d+)\]$/.exec(part);
    if (textMatch) {
      const n = Number(textMatch[1]);
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
    }
    const imageMatch = /^\[(图\d+(?:-\d+)?)\]$/.exec(part);
    if (imageMatch) {
      const label = imageMatch[1]!;
      return (
        <button
          key={i}
          type="button"
          onClick={() => onImageCite(label)}
          aria-label={`查看图像证据 ${label}`}
          className="mx-0.5 -translate-y-0.5 rounded border border-accent/25 bg-accent/10 px-1 font-mono text-[9px] leading-none text-accent/90 transition-colors duration-[var(--dur-fast)] hover:bg-accent/20 hover:text-accent"
        >
          {label}
        </button>
      );
    }
    return part;
  });
}
