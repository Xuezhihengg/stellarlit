"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

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

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-hair-2 bg-bg/95 p-1 shadow-[0_18px_45px_-22px_rgba(0,0,0,0.9)] backdrop-blur-xl"
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
