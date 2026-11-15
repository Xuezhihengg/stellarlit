"use client";

import Link from "next/link";

import { requestHome } from "@/lib/navigation/transition";

/**
 * 品牌标记。
 *
 * 那颗四角星是整份视觉里唯一"装饰性"的元素 —— 留一个记号,其余全部让给数据。
 *
 * 它同时是回首页的入口:点品牌回到种子输入页,是这类"一张图即一个应用"
 * 的界面里最不需要解释的导航。跳转走全局的幕布过渡,而不是整页刷新 ——
 * 只改查询串的同一个路由(`/?starfield=...` → `/`)不该丢掉那段淡入淡出。
 */
export function BrandMark() {
  const goHome = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // 交给浏览器处理新标签页/新窗口:那是用户明确表达的另一个意图
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    requestHome();
  };

  return (
    <Link
      href="/"
      // 画布与首页同路由,这一步由 Workspace 换幕;路由层的幕布跳转要放行给上面
      data-skip-transition="true"
      onClick={goHome}
      aria-label="回到首页"
      title="回到首页"
      className="flex items-center gap-3 rounded-lg transition-opacity duration-[var(--dur-fast)] hover:opacity-75"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M7 0.5 L8.1 5.9 L13.5 7 L8.1 8.1 L7 13.5 L5.9 8.1 L0.5 7 L5.9 5.9 Z"
          fill="currentColor"
          opacity="0.95"
        />
      </svg>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold tracking-[0.24em] text-ink uppercase">
          StellarLit
        </span>
        <span className="text-[11px] tracking-[0.08em] text-ink-4">学术星图</span>
      </div>
    </Link>
  );
}
