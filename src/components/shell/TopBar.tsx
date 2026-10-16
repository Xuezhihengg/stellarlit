import type { ReactNode } from "react";

interface TopBarProps {
  /** 左:品牌。 */
  brand?: ReactNode;
  /** 中:当前星空的标题(用户输入的那篇种子论文)。 */
  title?: string;
  /** 中:标题右侧的补充信息,例如论文年份。 */
  meta?: string;
  /** 右:统计与主题切换等。 */
  right?: ReactNode;
}

/**
 * 顶栏只留三样东西:品牌、当前星空的标题、右侧状态。
 *
 * 刻意不做导航菜单 —— 一个应用的导航如果是"首页/收藏/设置"，
 * 说明它的核心不是这张图。设置与历史收进右侧的状态区。
 */
export function TopBar({ brand, title, meta, right }: TopBarProps) {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-between gap-6 px-9 py-7">
      <div className="pointer-events-auto min-w-[180px]">{brand}</div>

      {title ? (
        <div className="pointer-events-auto hidden max-w-[560px] flex-col items-center md:flex">
          <div className="truncate text-[15px] text-ink">{title}</div>
          {meta ? (
            <div className="mt-1 font-mono text-[10px] tracking-[0.18em] text-ink-4 uppercase">
              {meta}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="pointer-events-auto flex min-w-[180px] items-center justify-end gap-4">
        {right}
      </div>
    </header>
  );
}
