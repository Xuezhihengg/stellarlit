"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type TransitionEvent,
} from "react";

export interface SelectMenuOption {
  value: string;
  label: string;
  note?: string;
  icon?: ReactNode;
  group?: string;
}

interface SelectMenuProps {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}

/** 自定义选择器:不依赖浏览器原生下拉框的视觉与尺寸。 */
export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  className = "",
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  /** 下方放不下就翻到触发按钮上方展开 —— 不压到窗口底部之外。 */
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const [maxHeight, setMaxHeight] = useState<number>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  // 挂载后、首次绘制前量一次:此时菜单还不可见,翻到上方不会有跳动。
  useLayoutEffect(() => {
    if (!mounted) return;
    const list = listRef.current;
    const trigger = rootRef.current?.querySelector("button");
    if (!list || !trigger) return;

    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const natural = list.scrollHeight;
    const next = natural > below && above > below ? "top" : "bottom";
    const space = next === "top" ? above : below;

    setPlacement(next);
    setMaxHeight(Math.min(256, Math.max(space, 120)));
  }, [mounted, options.length]);

  // 与弹窗同一套做法:先挂载、下一帧再翻转状态,过渡才有起点。
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    return undefined;
  }, [open]);

  // 关闭后留 220ms 让淡出跑完;亮起的瞬间又点开也能直接接管回来。
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const finishClose = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") {
      return;
    }
    if (!open && !visible) setMounted(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 text-left text-[11px] text-ink outline-none transition-colors duration-[var(--dur-fast)] hover:border-ink-4 focus-visible:border-accent/45"
      >
        {selected?.icon ? <span className="shrink-0">{selected.icon}</span> : null}
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-ink-2" : "text-ink-4"}`}>
          {selected?.label ?? placeholder}
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={`shrink-0 text-ink-4 transition-transform duration-[var(--dur-fast)] ${open ? "rotate-180" : ""}`}
          style={{ transitionTimingFunction: "var(--ease-out)" }}
        >
          <path
            d="M2 3.8 L5 6.6 L8 3.8"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {mounted ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-hidden={!open}
          className={`absolute z-30 w-full overflow-y-auto rounded-lg border border-hair-2 bg-bg/95 p-1 shadow-[0_18px_45px_-22px_rgba(0,0,0,0.9)] backdrop-blur-xl ${
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1"
          } ${visible ? "" : "pointer-events-none"}`}
          style={{
            maxHeight,
            opacity: visible ? 1 : 0,
            transform: visible
              ? "translateY(0) scale(1)"
              : `translateY(${placement === "top" ? 4 : -4}px) scale(0.98)`,
            transformOrigin: placement === "top" ? "bottom" : "top",
            transitionProperty: "opacity, transform",
            transitionDuration: "var(--dur-quick)",
            transitionTimingFunction: "var(--ease-in-out)",
          }}
          onTransitionEnd={finishClose}
        >
          {options.map((option, index) => {
            const active = option.value === value;
            const showGroup =
              Boolean(option.group) && options[index - 1]?.group !== option.group;
            return (
              <div key={option.value || "__empty__"}>
                {showGroup ? (
                  <p className="px-2.5 pt-2 pb-1 text-[9px] tracking-[0.1em] text-ink-4">
                    {option.group}
                  </p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] ${
                    active ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-hair/50"
                  }`}
                >
                  {option.icon ? <span className="mt-0.5 shrink-0">{option.icon}</span> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10.5px] leading-relaxed">{option.label}</span>
                    {option.note ? (
                      <span className="mt-0.5 block text-[9px] leading-relaxed text-ink-4">
                        {option.note}
                      </span>
                    ) : null}
                  </span>
                  {active ? <span className="text-[10px] text-accent">✓</span> : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
