"use client";

import type { StarfieldPayload } from "@/types/api";

interface BottomBarProps {
  payload: StarfieldPayload | null;
  viewHint: string;
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
  viewHint,
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
      className="pointer-events-none fixed bottom-0 left-0 z-30 pb-6 pl-9"
      style={{ right: rightInset, transition: "right var(--dur-base) var(--ease-out)" }}
    >
      {legend ? <div className="pointer-events-auto mb-3 flex justify-end">{legend}</div> : null}

      <div className="flex items-end justify-between gap-6">
        <div className="pointer-events-auto flex min-w-[220px] items-center gap-3">
          {ticks.length ? (
            <>
              <button
                type="button"
                onClick={() => onMinYearChange(null)}
                title="显示全部年份"
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors duration-[--dur-fast] ${
                  minYear === null ? "border-hair-2 text-ink-3" : "border-accent/50 text-accent"
                }`}
              >
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M1 1.2 L4.2 4.5 L1 7.8 Z" fill="currentColor" />
                  <path d="M4.6 1.2 L7.8 4.5 L4.6 7.8 Z" fill="currentColor" opacity="0.5" />
                </svg>
              </button>

              <div className="flex flex-1 items-center gap-0.5">
                {ticks.map((y) => {
                  const active = minYear !== null && y >= minYear;
                  return (
                    <button
                      key={y}
                      type="button"
                      onClick={() => onMinYearChange(minYear === y ? null : y)}
                      className={`flex-1 font-mono text-[10px] transition-colors duration-[--dur-fast] ${
                        active ? "text-accent" : "text-ink-4 hover:text-ink-3"
                      }`}
                    >
                      {y}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>

        <p className="pointer-events-none text-center text-[10.5px] tracking-[0.1em] text-ink-4">
          {viewHint}
        </p>

        <div className="min-w-[220px]" />
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
