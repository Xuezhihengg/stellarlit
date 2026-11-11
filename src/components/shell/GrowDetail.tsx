"use client";

import type { GraphStats } from "@/types/kg";

interface GrowProgress {
  round: number;
  depth: number;
  judged: number;
  matched: number;
  llmCalls: number;
}

interface GrowDetailProps {
  name?: string;
  stats: GraphStats | null;
  progress: GrowProgress | null;
  /** 构建已完成,正在做最后的收拢展示 */
  complete?: boolean;
}

const metricLabel = "font-mono text-[8px] tracking-[0.1em] text-ink-4";
const metricValue = "mt-0.5 font-mono text-[14px] leading-none tabular-nums text-ink-2";

/** 构建中的实时细节:图长到多大、查到第几层、判定了多少对。 */
export function GrowDetail({ name, stats, progress, complete = false }: GrowDetailProps) {
  const papers = stats?.papers ?? 0;
  const relations = stats?.byLayer.semantic ?? 0;
  const judged = progress?.judged ?? 0;
  const matched = progress?.matched ?? 0;
  const round = progress?.round ?? 1;
  const depth = progress?.depth ?? 3;
  const structureReady = complete || papers > 0;
  const finalRound = complete || Boolean(progress && progress.round >= progress.depth);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative overflow-hidden rounded-lg border border-hair bg-bg/30 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[8.5px] tracking-[0.12em] text-ink-4">STARFIELD</span>
          <span
            className={`rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] transition-colors duration-[var(--dur-base)] ${
              complete
                ? "border-accent/45 bg-accent/10 text-accent"
                : "border-accent/25 bg-accent/5 text-accent/85"
            }`}
          >
            {complete ? "构建完成" : "引文邻域"}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-relaxed text-ink-2">
          {name || "正在建立结构骨架…"}
        </p>
        {complete ? null : (
          <span
            aria-hidden="true"
            className="status-scan pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent/10 to-transparent"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-md border border-hair bg-bg/25 px-2 py-1.5">
          <p className={metricLabel}>论文</p>
          <p className={metricValue}>
            <RollingNumber value={papers} />
          </p>
        </div>
        <div className="rounded-md border border-hair bg-bg/25 px-2 py-1.5">
          <p className={metricLabel}>语义关系</p>
          <p className={metricValue}>
            <RollingNumber value={relations} />
          </p>
        </div>
        <div className="rounded-md border border-hair bg-bg/25 px-2 py-1.5">
          <p className={metricLabel}>判定对</p>
          <p className={metricValue}>
            <RollingNumber value={judged} />
          </p>
        </div>
        <div className="rounded-md border border-hair bg-bg/25 px-2 py-1.5">
          <p className={metricLabel}>命中关系</p>
          <p className={metricValue}>
            <RollingNumber value={matched} />
          </p>
        </div>
      </div>

      {progress ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[9.5px] text-ink-4">
            <span>
              {complete ? `已展开 ${round}/${depth} 层` : `第 ${round}/${depth} 层`}
            </span>
            <span className="font-mono">{progress.llmCalls} 次模型调用</span>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: depth }, (_, index) => (
              <span
                key={index}
                className={`h-px flex-1 transition-colors duration-[var(--dur-slow)] ${
                  complete || index < round ? "bg-accent/65" : "bg-hair-2"
                }`}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[10px] leading-relaxed text-ink-4">
          正在抓取第一层引文与参考文献…
        </p>
      )}

      <ul className="flex flex-col gap-1" aria-live="polite">
        <StepLine
          state={structureReady ? "done" : "active"}
          label={structureReady ? "结构骨架已就位" : "正在建立结构骨架…"}
          delayMs={0}
        />

        {structureReady ? (
          <StepLine
            state={progress ? "done" : "active"}
            label={progress ? "引文邻域已展开" : "正在抓取引文与参考文献"}
            delayMs={60}
          />
        ) : null}

        {structureReady && progress ? (
          <StepLine
            state={finalRound ? "done" : "active"}
            label={
              finalRound
                ? `关系判定完成,共命中 ${matched.toLocaleString()} 条关系`
                : `第 ${round}/${depth} 层:已判定 ${judged.toLocaleString()} 对,命中 ${matched.toLocaleString()} 条`
            }
            delayMs={0}
          />
        ) : null}

        {structureReady && finalRound ? (
          <StepLine
            state={complete ? "done" : "active"}
            label={complete ? "聚类与布局已完成" : "正在聚类并重算布局"}
            delayMs={60}
          />
        ) : null}
      </ul>
    </div>
  );
}

function StepLine({
  state,
  label,
  delayMs,
}: {
  state: "active" | "done";
  label: string;
  delayMs: number;
}) {
  return (
    <li
      className="build-step-enter flex items-center gap-2 text-[11px] leading-relaxed"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      {state === "done" ? (
        <CheckIcon />
      ) : (
        <span className="relative grid h-2 w-2 shrink-0 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
          <span className="relative h-1 w-1 rounded-full bg-accent" />
        </span>
      )}
      <span className={state === "done" ? "text-ink-3" : "build-step-live text-ink-2"}>
        {label}
      </span>
    </li>
  );
}

/** 指标翻牌:逐位滚动,只影响变化的数位。 */
function RollingNumber({ value }: { value: number }) {
  const text = Math.max(0, Math.floor(value)).toLocaleString();
  return (
    <span className="inline-flex">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex items-start">
        {Array.from(text).map((char, index) => {
          const key = text.length - index;
          return /^\d$/.test(char) ? (
            <RollingDigit key={key} digit={Number(char)} />
          ) : (
            <span key={key} className="inline-block w-[0.48ch] text-center">
              {char}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function RollingDigit({ digit }: { digit: number }) {
  return (
    <span className="relative inline-block h-[1em] w-[1ch] overflow-hidden align-top">
      <span
        className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-[520ms] will-change-transform"
        style={{
          transform: `translateY(-${digit}em)`,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        {Array.from({ length: 10 }, (_, number) => (
          <span key={number} className="grid h-[1em] place-items-center text-center">
            {number}
          </span>
        ))}
      </span>
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0 text-accent">
      <path
        d="M1.2 5.2 L3.7 7.6 L8.8 2.4"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
