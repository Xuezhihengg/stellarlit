"use client";

interface ResolveDetailProps {
  query: string;
}

interface SeedHint {
  label: string;
  source: string;
  note?: string;
}

/**
 * 按输入形状给出可解释的检索路径。
 *
 * 这里只做界面提示,真正的解析仍在服务端 `parseSeedQuery` 里完成;
 * 两边共用同一套「DOI / arXiv / OpenAlex ID / 标题」分类规则。
 */
function hintFor(raw: string): SeedHint {
  const value = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  if (/^https?:\/\/(?:www\.)?openalex\.org\//i.test(value) || /^W\d{6,}$/i.test(value)) {
    return {
      label: "OpenAlex ID",
      source: "OpenAlex",
      note: "按 OpenAlex ID 精确读取,不做标题猜测。",
    };
  }
  if (/^10\.48550\/arxiv\./i.test(value)) {
    return {
      label: "arXiv DOI",
      source: "arXiv 与 OpenAlex",
      note: "先取 arXiv 元数据,再匹配对应的引文记录。",
    };
  }
  if (/^10\.\d{4,9}\//.test(value)) {
    return {
      label: "DOI",
      source: "OpenAlex",
      note: "按 DOI 精确读取,避免标题同名造成误匹配。",
    };
  }
  if (/(?:arxiv\.org\/(?:abs|pdf)\/)?\d{4}\.\d{4,5}(?:v\d+)?/i.test(value)) {
    return {
      label: "arXiv ID",
      source: "arXiv 与 OpenAlex",
    };
  }
  return {
    label: "标题",
    source: "OpenAlex",
    note: "按标题相似度检索,并用年份辅助消歧。",
  };
}

export function ResolveDetail({ query }: ResolveDetailProps) {
  const hint = hintFor(query);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative overflow-hidden rounded-lg border border-hair bg-bg/30 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[8.5px] tracking-[0.12em] text-ink-4">SEED</span>
          <span className="rounded-full border border-accent/25 bg-accent/5 px-1.5 py-0.5 font-mono text-[8.5px] text-accent/85">
            {hint.label}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 break-all text-[10.5px] leading-relaxed text-ink-2">
          {query.trim() || "等待输入…"}
        </p>
        <span
          aria-hidden="true"
          className="status-scan pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent/10 to-transparent"
        />
      </div>

      <ul className="flex flex-col gap-1">
        <li className="flex items-center gap-1.5 text-[10px] leading-relaxed text-ink-3">
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" className="text-accent">
            <path
              d="M1.2 5.2 L3.7 7.6 L8.8 2.4"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>已识别为 {hint.label}</span>
        </li>
        <li className="flex items-center gap-1.5 text-[10px] leading-relaxed text-ink-2">
          <span className="h-1 w-1 shrink-0 animate-pulse rounded-full bg-accent" />
          <span>正在 {hint.source} 检索匹配记录</span>
        </li>
        <li className="flex items-center gap-1.5 text-[10px] leading-relaxed text-ink-4">
          <span className="h-1 w-1 shrink-0 rounded-full border border-ink-4/60" />
          <span>找到候选后消歧,再由你确认具体是哪一篇</span>
        </li>
      </ul>

      {hint.note ? (
        <p className="text-[9.5px] leading-relaxed text-ink-4">{hint.note}</p>
      ) : null}
    </div>
  );
}
