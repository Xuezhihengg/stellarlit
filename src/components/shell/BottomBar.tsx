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

  // 与侧栏同一个时长:图例是"跟着侧栏让开",不是自己先跑到位
  return (
    <div
      className="pointer-events-none fixed bottom-0 left-0 z-30 pb-8 pl-10"
      style={{ right: rightInset, transition: "right var(--dur-slow) var(--ease-out)" }}
    >
      {/*
        窄窗口下时间轴与图例互相让位,分三层退:

          ① 图例给自己留 16rem 的宽度底线。够就与时间轴并排,
             但只占「剩下的那些」—— 于是它永远不会向左滑到时间轴上方。
          ② 剩得不够 16rem,整块图例换到时间轴上方一行(`flex-wrap-reverse`
             让时间轴仍贴底),在整行宽度里重新排。
          ③ 容器连时间轴本身都放不下时,时间轴按百分比压缩(见 Timeline),
             压到一格不足 38px 就把年份藏起来,绝不再钻到侧栏底下。

        早先是 `shrink-0`:空间不够时图例不收缩,整块被顶到右边压进侧栏;
        而放开收缩之后,它又会一路向左铺满、盖在时间轴上。
      */}
      <div className="flex flex-wrap-reverse items-end gap-x-8 gap-y-2.5">
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

          宽屏下刻度间距 52px;窄屏按百分比等比压缩(见 Timeline),
          但每个刻度有不低于 40px 的底线 —— 再挤就开始叠字了。
        */}
        <div className="pointer-events-auto min-w-0 max-w-full">
          <div className="flex items-end gap-7">
            <button
              type="button"
              onClick={() => onMinYearChange(null)}
              aria-pressed={minYear === null}
              className={`shrink-0 pb-[7px] text-[10.5px] tracking-[0.16em] whitespace-nowrap transition-colors duration-[var(--dur-fast)] ${
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
        <div className="pointer-events-auto ml-auto min-w-0 max-w-full basis-64 grow">
          {legend}
        </div>
      </div>
    </div>
  );
}

/** 宽屏下的刻度间距(px)。窄屏不再固定它:轴按百分比随容器压缩。 */
const TICK_W = 52;

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
  const hasRange = firstActive >= 0;
  /** 没选年份时高亮段铺满整条轴、但完全透明:于是它"淡出"之后仍有一个稳定的起点 */
  const rangeStart = hasRange ? firstActive : 0;

  /**
   * 轴线坐标一律用百分比,不用像素。
   *
   * 像素写死之后,窗口一窄这条轴就顶穿容器、钻到侧栏底下 —— 它的宽度
   * 是 ticks × 52px,而容器宽度还得扣掉左侧留白。改成百分比后,
   * 轴随容器等比压缩:宽屏下仍是 52px 一格,窄屏下自动变密,永不溢出。
   */
  const step = 100 / ticks.length;
  /** 刻度标签居中在刻度点上,所以轴线两端各让半格 */
  const inset = step / 2;

  return (
    // 固有宽度给 52px 一格,但允许被压:minWidth 0 让它能收缩,
    // maxWidth 100% 保证收缩到父容器为止 —— 轴线本身是百分比,跟着一起变密。
    <div
      className="relative flex-initial overflow-hidden @container"
      style={{ width: ticks.length * TICK_W, maxWidth: "100%", minWidth: 0 }}
    >
      <span
        className="pointer-events-none absolute top-0 h-px bg-hair-2"
        style={{
          left: `${inset}%`,
          right: `${inset}%`,
          // 两端渐隐:硬边的轴线像一条边框,渐隐的才像"时间在延伸"
          maskImage: "linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)",
        }}
      />
      {/*
        "正在看哪一段"的高亮段:**始终挂载**,靠透明度出现/消失。

        之前它是条件渲染:选中年份时一下子长出来,点「全部」时一下子没了 ——
        和右下角关系筛选的开关不是一种语言(那边是淡到 35%)。
        现在换成同一种淡入淡出,左端与宽度也走同一段过渡,
        于是换年份时高亮是"滑过去"的,而不是跳到另一段。
      */}
      <span
        className="pointer-events-none absolute top-0 h-px bg-accent/55"
        style={{
          left: `${(rangeStart + 0.5) * step}%`,
          width: `${(lastIndex - rangeStart) * step}%`,
          opacity: hasRange ? 1 : 0,
          boxShadow: "0 0 7px color-mix(in srgb, var(--accent) 45%, transparent)",
          transition:
            "left var(--dur-fast) var(--ease-out), width var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out)",
        }}
      />

      <div className="flex items-start">
        {ticks.map((y, i) => {
          const active = firstActive >= 0 && i >= firstActive;
          // 被时间筛掉的年份:和关掉的关系图例一样淡下去,而不是整段变个颜色
          const excluded = firstActive >= 0 && i < firstActive;
          return (
            <button
              key={y}
              type="button"
              onClick={() => onPick(minYear === y ? null : y)}
              aria-pressed={minYear === y}
              title={`只看 ${y} 年及以后`}
              className={`group flex flex-col items-center transition-opacity duration-[var(--dur-fast)] ${
                excluded ? "opacity-40 hover:opacity-70" : "opacity-100"
              } min-w-0 flex-1`}
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
                className={`mt-[7px] font-mono text-[10.5px] tracking-[0.04em] whitespace-nowrap transition-colors duration-[var(--dur-fast)] @max-[230px]:hidden ${
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
