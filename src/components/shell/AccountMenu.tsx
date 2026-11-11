"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useSession } from "@/hooks/use-session";
import { fetchUsage } from "@/lib/api/client";
import { formatTokens } from "@/lib/format";
import { useStarfieldStore } from "@/stores/starfield-store";
import type { UsageSnapshotDto } from "@/types/account";

function initialOf(name?: string): string {
  const first = Array.from(name?.trim() ?? "")[0];
  return first ? first.toUpperCase() : "·";
}

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
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshotDto | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 每次打开都取一次:用户刚问完问题,进度条应该立刻反映新的消耗
  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    void fetchUsage()
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, user]);

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
        <span aria-hidden="true" className="font-mono text-[11.5px] leading-none font-medium uppercase">
          {initialOf(user?.name)}
        </span>
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-[7px] w-[7px] rounded-full border-2 border-bg ${
            llmReady ? "bg-accent" : "bg-warm"
          }`}
          title={llmReady ? "大模型已连接" : "未配置大模型,关系判定使用启发式规则"}
        />
      </button>

      <div
        role="menu"
        aria-hidden={!open}
        inert={!open}
        className={`absolute top-[calc(100%+14px)] right-0 z-50 w-[264px] overflow-hidden rounded-xl border border-hair-2 bg-surface/95 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.65)] backdrop-blur-md transition-opacity duration-[var(--dur-quick)] ease-out ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <div className="border-b border-hair px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-full border border-hair-2 font-mono text-[11px] text-ink-3">
              {initialOf(user?.name)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12.5px] text-ink">{user?.name ?? "未登录"}</p>
              <p className="truncate font-mono text-[10px] text-ink-4">
                {user?.email ?? (capabilities?.llmModel ? `模型 ${capabilities.llmModel}` : "未接入模型")}
              </p>
            </div>
          </div>
          {user && usage ? (
            <div className="mt-3">
              <div className="flex items-baseline justify-between gap-3 text-[9.5px] text-ink-4">
                <span>今日 token</span>
                <span className="font-mono">
                  {formatTokens(usage.tokens)} / {formatTokens(usage.budget)}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hair">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    usage.percent >= 100 ? "bg-alert/75" : "bg-accent/70"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, usage.percent))}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <nav className="p-1.5">
          <MenuLink href="/account" onSelect={() => setOpen(false)}>
            账号与用量
          </MenuLink>
          <MenuLink href="/history" onSelect={() => setOpen(false)}>
            历史星空
          </MenuLink>
          <MenuLink href="/settings" onSelect={() => setOpen(false)}>
            设置
          </MenuLink>
          {user ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[12.5px] text-ink-3 transition-colors duration-[var(--dur-fast)] hover:bg-hair hover:text-alert"
            >
              <span>退出登录</span>
              <span className="font-mono text-[9px] text-ink-4">{initialOf(user.name)}</span>
            </button>
          ) : null}
        </nav>

      </div>
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
