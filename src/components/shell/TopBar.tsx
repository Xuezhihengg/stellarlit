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
        中间一列 = 大标题 + 种子输入框。
        输入框是全局操作(换/并入种子),放在标题底下比塞进侧栏更像
        "这片星空的总入口";侧栏则专注读图与提问。
      */}
      <div className="pointer-events-auto flex min-w-0 max-w-[560px] flex-1 flex-col items-center gap-1.5">
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
        {search ? (
          <div className="w-full max-w-[420px] rounded-lg bg-bg/55 p-0.5 backdrop-blur-md">
            {search}
          </div>
        ) : null}
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center justify-end gap-4">
        {right}
      </div>
    </header>
  );
}
