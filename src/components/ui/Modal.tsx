"use client";

import { useEffect, useState, type ReactNode, type TransitionEvent } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}

/** 带进出场动效的统一弹窗容器。 */
export function Modal({
  open,
  onClose,
  label,
  children,
  className = "",
}: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);

  if (!mounted) return null;

  const finishClose = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") {
      return;
    }
    if (!open && !visible) setMounted(false);
  };

  return (
    <div
      className={`fixed inset-0 z-50 grid place-items-center bg-black/55 px-4 backdrop-blur-sm transition-opacity duration-[var(--dur-base)] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      role="presentation"
      style={{ transitionTimingFunction: "var(--ease-out)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onTransitionEnd={finishClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`max-h-[88dvh] w-full overflow-y-auto rounded-2xl border border-hair-2 bg-bg p-5 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.95)] transition-[opacity,transform] duration-[var(--dur-base)] ${
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.97] opacity-0"
        } ${className}`}
        style={{ transitionTimingFunction: "var(--ease-out)" }}
      >
        {children}
      </div>
    </div>
  );
}
