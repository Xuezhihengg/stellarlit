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
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-hair-2 bg-bg/65 px-3 py-2 backdrop-blur-md">
          {ticks.length ? (
            <>
              <button
                type="button"
                onClick={() => onMinYearChange(null)}
                title="显示全部年份"
                aria-pressed={minYear === null}
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors duration-[--dur-fast] ${
                  minYear === null
                    ? "text-ink-4 hover:bg-hair hover:text-ink-3"
                    : "bg-accent/12 text-accent"
                }`}
              >
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M1 1.2 L4.2 4.5 L1 7.8 Z" fill="currentColor" />
                  <path d="M4.6 1.2 L7.8 4.5 L4.6 7.8 Z" fill="currentColor" opacity="0.5" />
                </svg>
              </button>

              {/*
                时间轴画成"一条带刻度的轨道",而不是一排等宽按钮。
                轨道有起点和终点,按钮没有 —— 而这条轨道回答的正是
                「这个领域这些年是怎么变的」。
                选中的那一段轨道会亮起来,让"正在看哪一段"是位置信息而不是文字信息。
              */}
              <div className="relative flex items-center">
                <span className="pointer-events-none absolute inset-x-[7px] top-[11px] h-px bg-hair-2" />
                {minYear !== null ? (
                  <span
                    className="pointer-events-none absolute top-[11px] h-px bg-accent/70"
                    style={{
                      left: 7 + (ticks.findIndex((y) => y >= minYear) / Math.max(1, ticks.length)) * 100 + "%",
                      right: 7,
                    }}
                  />
                ) : null}

                {ticks.map((y) => {
                  const active = minYear !== null && y >= minYear;
                  return (
                    <button
                      key={y}
                      type="button"
                      onClick={() => onMinYearChange(minYear === y ? null : y)}
                      aria-pressed={minYear === y}
                      className="group relative flex w-[46px] flex-col items-center pt-[6px] pb-0.5"
                    >
                      <span
                        className={`h-[7px] w-[7px] rounded-full border transition-all duration-[--dur-fast] ${
                          active
                            ? "border-accent bg-accent"
                            : "border-ink-4 bg-bg group-hover:border-ink-3 group-hover:bg-ink-4"
                        }`}
                      />
                      <span
                        className={`mt-1.5 font-mono text-[10px] transition-colors duration-[--dur-fast] ${
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
            <p className="px-2 text-[10.5px] tracking-[0.08em] text-ink-4">
              输入一篇种子论文,星空会沿着它的研究脉络长出来
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
