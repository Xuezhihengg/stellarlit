import type { ButtonHTMLAttributes, ReactNode } from "react";

interface GhostButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** 选中态用强调色描边,不填充 —— 画面里唯一的"亮"要留给数据 */
  active?: boolean;
  size?: "sm" | "md";
  /** 胶囊形用于全站默认;rect 用于弹窗底部这类需要更克制的地方 */
  shape?: "pill" | "rect";
}

/**
 * 幽灵按钮。
 *
 * 为什么全站按钮都不填色:星图本身是低对比的深空,任何一块实的色块
 * 都会把注意力从数据上抢走。按钮靠边框与字色表达状态,足够了。
 */
export function GhostButton({
  children,
  active = false,
  size = "md",
  shape = "pill",
  className = "",
  ...rest
}: GhostButtonProps) {
  // 胶囊按钮的横向内边距要比纵向明显大,否则文字会"顶"着边框
  const pad = size === "sm" ? "px-3 py-[5px] text-[11px]" : "px-4 py-1.5 text-[12px]";
  const tone = active
    ? "border-accent/45 bg-accent/8 text-accent"
    : "border-hair-2 text-ink-3 hover:border-ink-4 hover:text-ink-2";
  const radius = shape === "rect" ? "rounded-md" : "rounded-full";

  return (
    <button
      type="button"
      className={`${radius} border ${pad} ${tone} font-normal tracking-[0.04em] whitespace-nowrap transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
