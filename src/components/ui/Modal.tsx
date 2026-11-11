"use client";

import { useEffect, useState, type ReactNode, type TransitionEvent } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * 带进出场动效的统一弹窗容器。
 *
 * 只有透明度变化,没有位移与缩放 —— 内容在原地浮现,不给人"被拖动"的感觉。
 * 进场慢、退场快:打开是"请你看",关闭是"知道了",后者不该让人等。
 */
export function Modal({
  open,
  onClose,
  label,
  children,
  className = "",
}: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  // 关闭后延迟卸载。正常情况由 transitionend 卸载,这里只是兜底:
  // 系统减弱动效时过渡几乎瞬时结束,不该让一个看不见的弹窗继续挂在 DOM 上。
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  if (!mounted || !portalReady) return null;

  const finishClose = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") {
      return;
    }
    if (!open && !visible) setMounted(false);
  };

  // 纯透明度变化最容易"啪一下亮起来",原因在曲线而不在时长:
  // --ease-out 起步极快(前 10% 的时间就走完三成),所以哪怕 320ms 也像突然出现。
  // 这里统一换成 S 形曲线,起步几乎为零、中段推进、末段收住,肉眼才跟得住。
  // 幕布比面板早一点到位(280 vs 380),压暗先发生,内容随后浮上来,层次不至于糊成一片。
  const scrimFade = {
    opacity: visible ? 1 : 0,
    transitionProperty: "opacity",
    transitionDuration: visible ? "var(--dur-base)" : "var(--dur-quick)",
    transitionTimingFunction: "var(--ease-in-out)",
  } as const;

  const panelFade = {
    opacity: visible ? 1 : 0,
    transitionProperty: "opacity",
    transitionDuration: visible ? "var(--dur-modal)" : "var(--dur-quick)",
    transitionTimingFunction: "var(--ease-in-out)",
  } as const;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center px-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* 幕布单独一层:模糊随透明度一起淡入,不会在打开的第一帧突兀地糊住背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-black/55 backdrop-blur-sm"
        style={scrimFade}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative z-10 max-h-[88dvh] w-full overflow-y-auto rounded-2xl border border-hair-2 bg-bg p-5 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.95)] ${className}`}
        style={panelFade}
        onTransitionEnd={finishClose}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
