"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useStarfieldStore } from "@/stores/starfield-store";

/**
 * 账户入口。
 *
 * 顶栏原来平铺着「历史星空 / 设置」两个链接,那是把**导航**当成了内容 ——
 * 它们既不是主线动作(输入种子),也不是当前语境的一部分,
 * 挂在外面只会持续占用注意力。收进头像里之后,顶栏只剩品牌、当前星空、
 * 状态与这一个入口。
 *
 * 头像上那个小圆点显示模型是否可用:它是全站唯一一个「系统状态」的常驻提示,
 * 因为「我现在的结论是模型判的还是规则猜的」这件事,用户随时需要知道。
 */
export function AccountMenu() {
  const capabilities = useStarfieldStore((s) => s.capabilities);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外面或按 Esc 都要能关掉 —— 下拉菜单最常见的挫败感就是关不掉
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const llmReady = Boolean(capabilities?.llm);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="账户与设置"
        className={`relative grid h-8 w-8 place-items-center rounded-full border transition-colors duration-[var(--dur-fast)] ${
          open ? "border-accent/45 text-accent" : "border-hair-2 text-ink-3 hover:text-ink-2"
        }`}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="5.6" r="2.7" stroke="currentColor" strokeWidth="1.25" />
          <path
            d="M2.9 13.4c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </svg>
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-[7px] w-[7px] rounded-full border-2 border-bg ${
            llmReady ? "bg-accent" : "bg-warm"
          }`}
          title={llmReady ? "大模型已连接" : "未配置大模型,关系判定使用启发式规则"}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-[calc(100%+14px)] right-0 w-[264px] overflow-hidden rounded-xl border border-hair-2 bg-surface/95 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.65)] backdrop-blur-md"
        >
          <div className="border-b border-hair px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-hair-2 text-ink-3">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="5.6" r="2.7" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M2.9 13.4c0-2.6 2.3-4.2 5.1-4.2s5.1 1.6 5.1 4.2"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] text-ink">本机账户</p>
                <p className="font-mono text-[10px] text-ink-4">
                  {capabilities?.llmModel ? `模型 ${capabilities.llmModel}` : "未接入模型"}
                </p>
              </div>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-4">
              这一版不需要登录:星空存在本机,只有论文标题与 ID 会发往 OpenAlex / arXiv。
            </p>
          </div>

          <nav className="p-1.5">
            <MenuLink href="/history" onSelect={() => setOpen(false)}>
              历史星空
            </MenuLink>
            <MenuLink href="/settings" onSelect={() => setOpen(false)}>
              设置
            </MenuLink>
          </nav>

          <div className="border-t border-hair px-4 py-2.5">
            <p className="font-mono text-[9.5px] tracking-[0.1em] text-ink-4 uppercase">
              {llmReady ? "关系判定 · 模型" : "关系判定 · 启发式"}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuLink({
  href,
  onSelect,
  children,
}: {
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onSelect}
      className="flex items-center justify-between rounded-lg px-3 py-2 text-[12.5px] text-ink-2 transition-colors duration-[var(--dur-fast)] hover:bg-hair hover:text-ink"
    >
      <span>{children}</span>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="text-ink-4">
        <path
          d="M3.4 1.6 L6.9 5 L3.4 8.4"
          stroke="currentColor"
          strokeWidth="1.1"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </Link>
  );
}
