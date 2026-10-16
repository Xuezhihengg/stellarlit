import type { ButtonHTMLAttributes, ReactNode } from "react";

interface GhostButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** 选中态用强调色描边,不填充 —— 画面里唯一的"亮"要留给数据 */
  active?: boolean;
  size?: "sm" | "md";
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
  className = "",
  ...rest
}: GhostButtonProps) {
  const pad = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3.5 py-1.5 text-[12px]";
  const tone = active
    ? "border-accent/45 text-accent"
    : "border-hair-2 text-ink-3 hover:border-hair-2 hover:text-ink-2";

  return (
    <button
      type="button"
      className={`rounded-full border ${pad} ${tone} font-normal tracking-[0.04em] transition-colors duration-[--dur-fast] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
