import type { ReactNode } from "react";

interface TopBarProps {
  /** 左:品牌。 */
  brand?: ReactNode;
  /** 中:当前星空的标题(用户输入的那篇种子论文)。 */
  title?: string;
  /**
   * 旧版的标题副行(如"N 篇种子 · 最近并入")。
   *
   * 设计上已经不再显示;保留这个可选字段只是为了让历史副本(如
   * 仓库里的 `page 2.tsx`)继续通过类型检查,不参与渲染。
   */
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
export function TopBar({ brand, title, search, right, rightInset = 0 }: TopBarProps) {
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
        标题默认"裸"在星空上;指针移上去,背景淡入、输入框一起展开。

        为什么用 hover + focus-within 两个条件:鼠标移开时应该收起,
        但如果用户正在输入(或按 ⌘K 聚焦),焦点在输入框里,它必须继续开着 ——
        否则打字打到一半面板缩回去,是比"隐藏"更糟的交互。

        标题本身是 <label>:点标题就能聚焦输入框,不用先悬停再瞄准输入框。
      */}
      <div className="group pointer-events-auto flex min-w-0 max-w-[560px] flex-1 flex-col rounded-xl border border-transparent px-4 py-1.5 transition-[background-color,border-color,box-shadow] duration-[var(--dur-base)] hover:border-hair hover:bg-bg/55 hover:shadow-[0_18px_44px_-30px_rgba(0,0,0,0.9)] focus-within:border-accent/35 focus-within:bg-bg/55">
        <label htmlFor="seed-search" className="flex w-full min-w-0 cursor-text items-baseline justify-center">
          <span className="min-w-0 truncate text-center text-[15px] text-ink">
            {title ?? "还没有星空"}
          </span>
        </label>

        <div className="max-h-0 overflow-hidden opacity-0 transition-[max-height,opacity] duration-[var(--dur-base)] group-hover:max-h-14 group-hover:opacity-100 group-focus-within:max-h-14 group-focus-within:opacity-100">
          <div className="pt-1">
            <div className="h-px bg-hair" />
            {search ? <div className="w-full pt-1">{search}</div> : null}
          </div>
        </div>
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center justify-end gap-4">
        {right}
      </div>
    </header>
  );
}
