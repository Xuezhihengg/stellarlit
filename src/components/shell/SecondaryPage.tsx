import Link from "next/link";
import type { ReactNode } from "react";

interface SecondaryPageProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 次级页面的外壳(历史、设置)。
 *
 * 这两页刻意不用星空背景:它们在回答「我有哪些星空」「我的判定标准是什么」,
 * 属于管理动作而非探索动作。同一套星图底噪会让管理界面显得吵,
 * 也会让评委分不清哪里是"看数据"哪里是"改设置"。
 */
export function SecondaryPage({ title, subtitle, actions, children }: SecondaryPageProps) {
  return (
    <main className="h-dvh overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[1080px] px-8 py-12">
        <header className="mb-10 flex items-start justify-between gap-6">
          <div>
            <Link
              href="/"
              className="mb-4 inline-flex items-center gap-2 text-[11px] text-ink-4 transition-colors hover:text-ink-2"
            >
              ← 返回首页
            </Link>
            <h1 className="text-[22px] tracking-[0.02em] text-ink">{title}</h1>
            {subtitle ? (
              <p className="mt-2 max-w-[620px] text-[12.5px] leading-[1.8] text-ink-3">
                {subtitle}
              </p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0 pt-8">{actions}</div> : null}
        </header>
        {children}
      </div>
    </main>
  );
}
