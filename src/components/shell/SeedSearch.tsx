"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 种子论文输入框。
 *
 * 接受的输入形式写在占位符里,而不是等用户猜错之后再报错 ——
 * 「支持什么」是产品信息,不该藏在错误提示里。
 */
interface SeedSearchProps {
  value: string;
  busy: boolean;
  /** 已有星空时,按钮文案变成「并入星空」 */
  growing?: boolean;
  /** 裸模式:去掉自己的边框与底色,交给外层容器做"标题 + 搜索"的一体化 */
  bare?: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}

const EXAMPLES = [
  "Attention Is All You Need",
  "1706.03762",
  "10.48550/arxiv.2005.11401",
  "W2626778328",
];

export function SeedSearch({
  value,
  busy,
  growing = false,
  bare = false,
  onChange,
  onSubmit,
}: SeedSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hintIndex, setHintIndex] = useState(0);

  // 占位符轮播:让「能输入什么」自己讲出来,不用点开帮助
  useEffect(() => {
    if (value) return;
    const t = setInterval(() => setHintIndex((i) => (i + 1) % EXAMPLES.length), 3600);
    return () => clearInterval(t);
  }, [value]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="relative"
    >
      {bare ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-0 -translate-y-1/2 text-ink-4"
        >
          <circle cx="5" cy="5" r="3.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M7.4 7.4 L10.2 10.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      ) : null}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        spellCheck={false}
        aria-label="种子论文"
        placeholder={`标题 / arXiv ID / DOI / OpenAlex ID,如 ${EXAMPLES[hintIndex]}`}
        className={
          bare
            ? "h-8 w-full bg-transparent pr-16 pl-5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
            : "h-9 w-full rounded-lg border border-hair-2 bg-transparent pr-16 pl-3 text-[12.5px] text-ink transition-colors duration-[var(--dur-fast)] placeholder:text-ink-4 focus:border-accent/45 disabled:opacity-50"
        }
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className={`absolute top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] tracking-[0.06em] text-ink-3 transition-colors duration-[var(--dur-fast)] hover:text-accent disabled:opacity-30 ${
          bare ? "right-0" : "right-1.5"
        }`}
      >
        {busy ? "…" : growing ? "并入" : "解析"}
      </button>
    </form>
  );
}
