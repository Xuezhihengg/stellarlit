"use client";

import type { StarfieldPayload } from "@/types/api";

interface BottomBarProps {
  payload: StarfieldPayload | null;
  minYear: number | null;
  /** 被侧栏遮住的宽度:图例与时间轴都要让开它 */
  rightInset?: number;
  onMinYearChange: (year: number | null) => void;
  legend?: React.ReactNode;
}

/**
 * 底部：时间轴 + 图例 + 操作提示。
 *
 * 时间轴放在底部而不是做成侧边控件,是因为它回答的是「这个领域这些年怎么变的」——
 * 一个横向的年份刻度天然就是这条时间线的形状。
 */
export function BottomBar({
  payload,
  minYear,
  rightInset = 0,
  onMinYearChange,
  legend,
}: BottomBarProps) {
  const years = payload
    ? payload.graph.nodes.filter((n) => n.kind === "paper").map((n) => n.year).filter((y) => y > 0)
    : [];

  const min = years.length ? Math.min(...years) : 0;
  const max = years.length ? Math.max(...years) : new Date().getFullYear();
  const ticks = min && max > min ? buildTicks(min, max) : [];

  return (
    <div
      className="pointer-events-none fixed bottom-0 left-0 z-30 pb-7 pl-9"
      style={{ right: rightInset, transition: "right var(--dur-base) var(--ease-out)" }}
    >
      <div className="flex items-end justify-between gap-8">
        {/* ---------- 时间轴 ---------- */}
        <div className="pointer-events-auto flex items-center gap-4">
          {ticks.length ? (
            <>
              <button
                type="button"
                onClick={() => onMinYearChange(null)}
                title="显示全部年份"
                aria-pressed={minYear === null}
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-colors duration-[--dur-fast] ${
                  minYear === null
                    ? "border-hair-2 text-ink-4 hover:border-ink-4 hover:text-ink-3"
                    : "border-accent/45 bg-accent/8 text-accent"
                }`}
              >
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M1 1.2 L4.2 4.5 L1 7.8 Z" fill="currentColor" />
                  <path d="M4.6 1.2 L7.8 4.5 L4.6 7.8 Z" fill="currentColor" opacity="0.5" />
                </svg>
              </button>

              {/*
                年份刻度做成"一条轴线 + 刻度点 + 标签",而不是一排等宽的按钮。
                等宽按钮看起来像筛选器,轴线看起来像时间 —— 而这条轴回答的正是
                「这个领域这些年怎么变的」。
              */}
              <div className="relative flex items-center gap-0">
                <span className="pointer-events-none absolute inset-x-1 top-1/2 h-px bg-hair" />
                {ticks.map((y) => {
                  const active = minYear !== null && y >= minYear;
                  return (
                    <button
                      key={y}
                      type="button"
                      onClick={() => onMinYearChange(minYear === y ? null : y)}
                      aria-pressed={minYear === y}
                      className="group relative flex flex-col items-center px-2 pt-2.5 pb-1"
                    >
                      <span
                        className={`absolute top-[7px] h-1 w-1 rounded-full transition-colors duration-[--dur-fast] ${
                          active ? "bg-accent" : "bg-ink-4 group-hover:bg-ink-3"
                        }`}
                      />
                      <span
                        className={`font-mono text-[10px] transition-colors duration-[--dur-fast] ${
                          active ? "text-accent" : "text-ink-4 group-hover:text-ink-3"
                        }`}
                      >
                        {y}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-[10.5px] tracking-[0.1em] text-ink-4">
              输入一篇种子论文 · 星空会沿着它的研究脉络长出来
            </p>
          )}
        </div>

        {/* ---------- 图例 = 筛选器 ---------- */}
        <div className="pointer-events-auto shrink-0">{legend}</div>
      </div>
    </div>
  );
}

function buildTicks(min: number, max: number): number[] {
  const span = max - min;
  const step = span <= 8 ? 1 : span <= 20 ? 2 : 5;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let y = start; y <= max; y += step) out.push(y);
  // 年份太多时只保留偶数年,否则刻度会挤成一片
  return out.length > 14 ? out.filter((_, i) => i % 2 === 0) : out;
}
