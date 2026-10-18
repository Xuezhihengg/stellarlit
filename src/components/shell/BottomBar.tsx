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
      className="pointer-events-none fixed bottom-0 left-0 z-30 pb-8 pl-10"
      style={{ right: rightInset, transition: "right var(--dur-base) var(--ease-out)" }}
    >
      <div className="flex items-end justify-between gap-8">
        {/* ---------- 时间轴 ---------- */}
        {/*
          极简轴线。

          上一版的问题不是颜色或间距,而是**信息密度与层次错了**:
          15 个刻度、每个配一个圆点、再装进一个带边框的圆角盒子 ——
          每个元素都在争同样的注意力,读起来像控制面板。

          这一版只留三样东西:一条轴线、稀疏的刻度、克制的年份。
          盒子去掉了(靠一层几乎看不见的径向压暗保证星图上可读),
          圆点改成短竖线,年份按跨度自动稀疏到不超过 6 个。
          「正在看哪一段」由轴线本身的明暗表达 —— 位置信息,不是文字信息。

          刻度间距固定 52px,所以轴线与高亮段都用**像素**算,
          不用百分比 —— 百分比会在刻度数变化时对不齐。
        */}
        <div className="pointer-events-auto">
          <div className="flex items-end gap-7">
            <button
              type="button"
              onClick={() => onMinYearChange(null)}
              aria-pressed={minYear === null}
              className={`pb-[7px] text-[10.5px] tracking-[0.16em] transition-colors duration-[var(--dur-fast)] ${
                minYear === null ? "text-ink-3 hover:text-ink-2" : "text-accent/80 hover:text-accent"
              }`}
            >
              全部
            </button>

            {ticks.length ? (
              <Timeline ticks={ticks} minYear={minYear} onPick={onMinYearChange} />
            ) : (
              <p className="pb-[7px] text-[10.5px] tracking-[0.08em] text-ink-4">
                输入种子论文,星空会沿着它的研究脉络长出来
              </p>
            )}
          </div>
        </div>

        {/* ---------- 图例 = 筛选器 ---------- */}
        <div className="pointer-events-auto shrink-0">{legend}</div>
      </div>
    </div>
  );
}

/** 刻度间距(px)。轴线与高亮段都按它算,保证任何刻度数下都对齐。 */
const TICK_W = 52;
const TRACK_INSET = TICK_W / 2;

/**
 * 一条轴线 + 一串刻度。
 *
 * 轴线的静段几乎看不见,亮段才是"当前范围" —— 这样"在看哪一段"
 * 是一个位置事实,不需要再配一句说明文字。
 */
function Timeline({
  ticks,
  minYear,
  onPick,
}: {
  ticks: number[];
  minYear: number | null;
  onPick: (year: number | null) => void;
}) {
  const firstActive = minYear === null ? -1 : ticks.findIndex((y) => y >= minYear);
  const lastIndex = ticks.length - 1;

  return (
    <div className="relative" style={{ width: ticks.length * TICK_W }}>
      <span
        className="pointer-events-none absolute top-0 h-px bg-hair-2"
        style={{
          left: TRACK_INSET,
          right: TRACK_INSET,
          // 两端渐隐:硬边的轴线像一条边框,渐隐的才像"时间在延伸"
          maskImage: "linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)",
        }}
      />
      {firstActive >= 0 ? (
        <span
          className="pointer-events-none absolute top-0 h-px bg-accent/55"
          style={{
            left: TRACK_INSET + firstActive * TICK_W,
            width: (lastIndex - firstActive) * TICK_W,
            boxShadow: "0 0 7px color-mix(in srgb, var(--accent) 45%, transparent)",
          }}
        />
      ) : null}

      <div className="flex items-start">
        {ticks.map((y, i) => {
          const active = firstActive >= 0 && i >= firstActive;
          return (
            <button
              key={y}
              type="button"
              onClick={() => onPick(minYear === y ? null : y)}
              aria-pressed={minYear === y}
              title={`只看 ${y} 年及以后`}
              className="group flex flex-col items-center"
              style={{ width: TICK_W }}
            >
              {/* 刻度从轴线上垂下来 */}
              <span
                className={`w-px transition-all duration-[var(--dur-fast)] ${
                  active
                    ? "h-[9px] bg-accent"
                    : "h-[6px] bg-ink-4 group-hover:h-[9px] group-hover:bg-ink-3"
                }`}
              />
              <span
                className={`mt-[7px] font-mono text-[10.5px] tracking-[0.04em] transition-colors duration-[var(--dur-fast)] ${
                  active ? "text-accent" : "text-ink-3 group-hover:text-ink-2"
                }`}
              >
                {y}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 刻度稀疏化。
 *
 * 目标不是"把年份都标出来",而是**一眼看出跨度**。
 * 一个 15 年的区间标 15 个年份,读到的是噪声;标 5 个,读到的才是趋势。
 * 所以步长按跨度自动选,并把刻度数压在 6 个以内。
 */
function buildTicks(min: number, max: number): number[] {
  const span = Math.max(0, max - min);
  const step = [1, 2, 3, 5, 10].find((s) => span / s <= 6) ?? 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let y = start; y <= max; y += step) out.push(y);
  return out.length ? out : [max];
}
