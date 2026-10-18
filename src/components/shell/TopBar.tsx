import type { ReactNode } from "react";

interface TopBarProps {
  /** 左:品牌。 */
  brand?: ReactNode;
  /** 中:当前星空的标题(用户输入的那篇种子论文)。 */
  title?: string;
  /** 中:标题右侧的补充信息,例如论文年份。 */
  meta?: string;
  /** 中:标题下方的种子输入框(全局操作,不放在侧栏里) */
  search?: ReactNode;
  /** 右:统计与主题切换等。 */
  right?: ReactNode;
  /** 被侧栏遮住的宽度:顶栏右侧内容要让开它,否则会被压在侧栏底下。 */
  rightInset?: number;
}

/**
 * 顶栏只留三样东西:品牌、当前星空的标题、右侧状态。
 *
 * 刻意不做导航菜单 —— 一个应用的导航如果是"首页/收藏/设置"，
 * 说明它的核心不是这张图。设置与历史收进右侧的状态区。
 */
export function TopBar({ brand, title, meta, search, right, rightInset = 0 }: TopBarProps) {
  /**
   * 让开侧栏的距离必须**和侧栏本身一样快**。
   *
   * 之前这里是 --dur-base(280ms),而侧栏滑出是 --dur-slow(620ms):
   * 顶栏 0.28 秒就位,侧栏还在走,看上去像两个互不相干的动作。
   */
  return (
    <header
      className="pointer-events-none fixed top-0 left-0 z-30 flex items-start justify-between gap-6 py-5 pr-9 pl-9"
      style={{ right: rightInset, transition: "right var(--dur-slow) var(--ease-out)" }}
    >
      <div className="pointer-events-auto min-w-[180px] shrink-0">{brand}</div>

      {/*
        大标题与种子输入**合成一个控件**。

        之前是"一行标题 + 一个独立的输入框":两块各自有边界,看起来像
        两个东西叠在一起。现在共用一层圆角底、一条细分割线:
        上半是"现在看的是哪片星空",下半是"并入新的种子",聚焦时整块
        一起亮边框 —— 读起来是一个"星图标题栏"。
      */}
      <div className="pointer-events-auto flex min-w-0 max-w-[560px] flex-1 flex-col rounded-xl border border-hair bg-bg/45 px-4 pt-2.5 pb-1 backdrop-blur-md transition-colors duration-[var(--dur-fast)] focus-within:border-accent/35">
        <div className="flex w-full min-w-0 items-baseline justify-center gap-2">
          <div className="min-w-0 truncate text-center text-[15px] text-ink">
            {title ?? "还没有星空"}
          </div>
          {meta ? (
            <div className="shrink-0 font-mono text-[9.5px] tracking-[0.12em] text-ink-4">
              {meta}
            </div>
          ) : null}
        </div>
        <div className="my-1 h-px bg-hair" />
        {search ? (
          <div className="w-full">{search}</div>
        ) : null}
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center justify-end gap-4">
        {right}
      </div>
    </header>
  );
}
