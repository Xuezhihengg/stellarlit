import type { SeedCandidate } from "@/types/starfield";

interface SeedConfirmProps {
  candidates: SeedCandidate[];
  onPick: (c: SeedCandidate) => void;
  onDismiss: () => void;
}

/**
 * 种子确认。
 *
 * 这一步不是多余的手续,而是**产品对数据源不信任的诚实表达**:
 * 实测 OpenAlex 会把 arXiv 的自动 DOI 映射到完全不相干的论文,
 * 也会把同名论文合并成一条年份离谱的记录。
 * 与其替用户挑一条,不如把候选、置信度和推荐理由一起摊开。
 */
export function SeedConfirm({ candidates, onPick, onDismiss }: SeedConfirmProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-[0.12em] text-ink-4">
          确认你要的是哪一篇
        </span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-ink-4 transition-colors hover:text-ink-2"
        >
          取消
        </button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {candidates.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className="group w-full rounded-lg border border-hair px-3 py-2.5 text-left transition-colors duration-[--dur-fast] hover:border-accent/40"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-[12.5px] leading-snug text-ink">{c.title}</span>
                <span className="mt-0.5 shrink-0 font-mono text-[10px] text-ink-4">
                  {(c.confidence * 100).toFixed(0)}%
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-4">
                <span>{c.year || "年份未知"}</span>
                <span>被引 {c.citations.toLocaleString()}</span>
                {c.venue ? <span className="truncate max-w-[160px]">{c.venue}</span> : null}
              </div>

              <div className="mt-1.5 flex items-center gap-2">
                <span className="text-[10.5px] leading-relaxed text-ink-3">{c.reason}</span>
                {c.alreadyInStarfield ? (
                  <span className="shrink-0 rounded-full border border-warm/40 px-1.5 py-px text-[9.5px] text-warm">
                    已在星空
                  </span>
                ) : null}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
