"use client";

import { useStarfieldStore } from "@/stores/starfield-store";

interface QuotaNoticeProps {
  /** 侧栏占掉的宽度:提示要让开它,别被压在面板底下 */
  rightInset?: number;
}

/**
 * 数据源额度提示。
 *
 * 它不是"当前这篇论文"的问题,也不是观星台里某一步操作的结果,
 * 而是"现在建不了新图"这个全局状态 —— 放在侧栏里会跟着详情一起滚动,
 * 还会被误读成当前论文出错了。所以挪到星图上方的一条独立提示:
 * 谁在看图都能看到,关掉也不影响正在读的内容。
 */
export function QuotaNotice({ rightInset = 0 }: QuotaNoticeProps) {
  const error = useStarfieldStore((s) => s.error);
  const clearError = useStarfieldStore((s) => s.clearError);

  if (!error || error.code !== "quota") return null;

  return (
    <div
      className="pointer-events-none fixed top-[74px] left-0 z-30 flex justify-center px-6"
      style={{ right: rightInset, transition: "right var(--dur-slow) var(--ease-out)" }}
    >
      <div className="pointer-events-auto flex w-full max-w-[560px] items-start gap-3 rounded-xl border border-warm/35 bg-bg/88 px-4 py-3 shadow-[0_16px_40px_-24px_rgba(0,0,0,0.9)] backdrop-blur-md">
        <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warm" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-snug text-ink-2">{error.message}</p>
          {error.hint ? (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-4">{error.hint}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={clearError}
          aria-label="关闭提示"
          className="-mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[14px] leading-none text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink-2"
        >
          ×
        </button>
      </div>
    </div>
  );
}
