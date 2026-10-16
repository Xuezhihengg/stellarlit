"use client";

import Link from "next/link";

/** 顶栏右侧的两个入口。放在这里是刻意的:它们不是导航,只是两个管理动作。 */
export function NavLinks() {
  const item = "text-[10.5px] tracking-[0.12em] text-ink-4 transition-colors hover:text-ink-2";
  return (
    <nav className="flex items-center gap-4">
      <Link href="/history" className={item}>
        历史星空
      </Link>
      <Link href="/settings" className={item}>
        设置
      </Link>
    </nav>
  );
}
