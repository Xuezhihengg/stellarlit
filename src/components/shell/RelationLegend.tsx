"use client";

import type { StarfieldPayload } from "@/types/api";

import { edgeKindOf } from "@/lib/graph/edge-kinds";

interface RelationLegendProps {
  payload: StarfieldPayload;
  dimmedKinds: Set<string>;
  onToggle: (kind: string) => void;
}

/**
 * 关系图例,同时兼任筛选器。
 *
 * 图例与筛选合并成同一个控件,是因为它们回答的是同一个问题:
 * 「这条线是什么意思」。点一下就能把它关掉,比先看说明再去找筛选菜单快得多。
 */
export function RelationLegend({ payload, dimmedKinds, onToggle }: RelationLegendProps) {
  const counts = new Map<string, number>();
  for (const e of payload.graph.edges) {
    if (e.layer !== "semantic") continue;
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }

  const presets = payload.presets.filter((p) => p.enabled);
  if (!presets.length) return null;

  /** 引用边和语义关系一样，是一个可开关的"关系类型"。 */
  const citation = {
    id: "citation",
    label: "引用",
    description: "来自 OpenAlex 的引用记录。它是星图的骨架，默认为暗色。",
    tone: "var(--ink-3)",
    dash: undefined as string | undefined,
    directed: true,
    kind: "CITES",
    count: counts.get("CITES") ?? 0,
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[citation, ...presets.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        tone: p.visual.tone,
        dash: p.visual.dash,
        directed: p.directed,
        kind: edgeKindOf(p.id),
        count: counts.get(edgeKindOf(p.id)) ?? 0,
      }))].map((p) => {
        const kind = p.kind;
        const n = p.count;
        const off = dimmedKinds.has(kind);

        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onToggle(kind)}
            title={p.description}
            className={`group flex items-center gap-2 rounded-full border border-transparent px-2.5 py-[5px] transition-all duration-[var(--dur-fast)] hover:border-hair-2 hover:bg-hair/40 ${
              off ? "opacity-35" : "opacity-100"
            }`}
          >
            <span
              className="h-px w-4 shrink-0"
              style={{
                backgroundColor: p.tone,
                ...(p.dash && p.dash !== "none"
                  ? {
                      backgroundImage: `repeating-linear-gradient(90deg, ${p.tone} 0 2px, transparent 2px 6px)`,
                      backgroundColor: "transparent",
                    }
                  : {}),
              }}
            />
            <span className="text-[10.5px] tracking-[0.02em] text-ink-3 transition-colors group-hover:text-ink-2">
              {p.label}
            </span>
            <span className="font-mono text-[9.5px] text-ink-4">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
