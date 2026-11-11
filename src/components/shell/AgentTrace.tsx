"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { AskDecision, AskStep } from "@/types/rag";

interface AgentTraceProps {
  trace: AskStep[];
  decisions: AskDecision[];
  busy: boolean;
  /** 结果已经开始输出:结束后自动收起轨迹 */
  hasResult: boolean;
}

function stateColor(state: AskStep["state"]): string {
  if (state === "failed") return "bg-alert";
  if (state === "empty") return "bg-ink-4";
  if (state === "running") return "bg-accent/55";
  return "bg-accent";
}

function stopLabel(decision: AskDecision | undefined): string {
  if (!decision) return "正在规划";
  if (decision.action === "continue") return "补充检索中";
  return decision.code === "enough" ? "证据足够" : "证据不足";
}

function stopTone(decision: AskDecision | undefined): string {
  if (!decision) return "border-hair text-ink-4";
  if (decision.action === "continue") return "border-warm/30 text-warm";
  return decision.code === "enough"
    ? "border-accent/30 text-accent/90"
    : "border-warm/30 text-warm";
}

/**
 * Agent 决策轨迹:不是日志倾倒,只保留三次关键信息 ——
 * 这轮查了什么、查到了多少、为什么继续或停止。
 */
export function AgentTrace({ trace, decisions, busy, hasResult }: AgentTraceProps) {
  const rounds = [
    ...new Set([...trace.map((step) => step.round), ...decisions.map((item) => item.round)]),
  ].sort((a, b) => a - b);
  const lastDecision = decisions[decisions.length - 1];
  const running = busy && lastDecision?.action !== "stop";
  const bodyId = useId();
  const [open, setOpen] = useState(
    () => !(hasResult && lastDecision?.action === "stop"),
  );
  const collapsedForResult = useRef(false);

  // 新一轮提问自动展开;第一个回答 token 出现后自动收起一次,之后把控制权交回用户。
  useEffect(() => {
    if (!hasResult) {
      collapsedForResult.current = false;
      setOpen(true);
      return;
    }
    if (lastDecision?.action === "stop" && !collapsedForResult.current) {
      collapsedForResult.current = true;
      setOpen(false);
    }
  }, [hasResult, lastDecision]);

  return (
    <div
      className="agent-trace mt-2 overflow-hidden rounded-lg border border-hair bg-bg/25"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={bodyId}
        title={open ? "收起决策轨迹" : "展开决策轨迹"}
        className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hair/20 ${
          open ? "border-b border-hair/70" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-accent ${running ? "animate-pulse" : "opacity-60"}`}
          />
          <span className="truncate font-mono text-[9px] tracking-[0.12em] text-ink-3">
            决策轨迹
          </span>
          {rounds.length ? (
            <span className="shrink-0 font-mono text-[8.5px] text-ink-4">{rounds.length} 轮</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {lastDecision?.stats.mode ? (
            <span
              className={`hidden rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] sm:inline ${
                lastDecision.stats.mode === "hybrid"
                  ? "border-accent/25 text-accent/85"
                  : "border-hair text-ink-4"
              }`}
              title={
                lastDecision.stats.mode === "hybrid"
                  ? "BM25 与向量召回经 RRF 融合"
                  : "向量模型未配置,当前仅用词面召回"
              }
            >
              {lastDecision.stats.mode === "hybrid" ? "混合召回" : "词面召回"}
            </span>
          ) : null}
          <span
            className={`rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] ${stopTone(lastDecision)}`}
          >
            {stopLabel(lastDecision)}
          </span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={`text-ink-4 transition-transform duration-[var(--dur-fast)] ${open ? "rotate-180" : ""}`}
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
        </div>
      </button>

      <div
        id={bodyId}
        className="agent-trace-body"
        data-open={open ? "true" : "false"}
        aria-hidden={!open}
      >
        <div>
          <div className="max-h-44 overflow-y-auto px-2.5 py-1.5">
            {rounds.length ? (
              rounds.map((round) => {
                const steps = trace.filter((step) => step.round === round);
                const decision = decisions.find((item) => item.round === round);
                return (
                  <div key={round} className="agent-round py-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-4">
                        第 {round} 轮
                      </span>
                      {decision?.action === "continue" ? (
                        <span className="font-mono text-[8px] text-warm/85">发现缺口</span>
                      ) : null}
                    </div>
                    {steps.length ? (
                      <ul className="mt-0.5 flex flex-col gap-0.5">
                        {steps.map((step, index) => (
                          <li
                            key={step.slot}
                            title={[step.why, step.detail].filter(Boolean).join(" · ")}
                            className="agent-step-enter min-w-0 text-[9.5px] leading-relaxed"
                            style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
                          >
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={`h-1 w-1 shrink-0 rounded-full ${stateColor(step.state)}`}
                              />
                              <span className="shrink-0 text-ink-3">{step.label}</span>
                              {step.detail ? (
                                <span className="min-w-0 truncate text-ink-4">· {step.detail}</span>
                              ) : null}
                            </div>
                            {step.why ? (
                              <p className="mt-0.5 ml-2.5 line-clamp-1 text-[8.5px] leading-snug text-ink-4/70">
                                {step.why}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {decision ? (
                      <p
                        className={`agent-step-enter mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[9.5px] leading-relaxed ${
                          decision.action === "continue" ? "text-warm/90" : "text-ink-4"
                        }`}
                        style={{ animationDelay: `${Math.min(steps.length, 6) * 45}ms` }}
                      >
                        <span className="shrink-0 font-mono text-[8.5px]">
                          {decision.action === "continue" ? "↳" : "■"}
                        </span>
                        <span className="min-w-0">{decision.reason}</span>
                        <span className="shrink-0 font-mono text-[8.5px] text-ink-4/70">
                          {decision.stats.sources} 块 · {decision.stats.papers} 篇
                          {decision.stats.relations ? ` · ${decision.stats.relations} 关系` : ""}
                          {decision.stats.imageChunks
                            ? ` · ${decision.stats.imageChunks} 图块`
                            : ""}
                          {typeof decision.stats.coverage === "number"
                            ? ` · 覆盖 ${(decision.stats.coverage * 100).toFixed(0)}%`
                            : ""}
                        </span>
                      </p>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="py-0.5 text-[9.5px] text-ink-4">正在判断需要查哪些证据…</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
