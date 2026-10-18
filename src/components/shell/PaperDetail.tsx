"use client";

import { useEffect, useMemo, useState } from "react";

import { Collapsible } from "@/components/ui/Collapsible";
import type { StarfieldPayload } from "@/types/api";
import type { Evidence, GraphEdge, PaperNode } from "@/types/kg";

interface PaperDetailProps {
  payload: StarfieldPayload;
  paper: PaperNode;
  onFocusPaper: (id: string) => void;
  onClear: () => void;
}

/**
 * 论文详情 + 关系证据。
 *
 * 这个面板是整个作品「反幻觉」主张的落点:
 * 每条关系旁边都能展开模型判定时引用的**原文片段**,
 * 并且标出这条判定来自模型还是来自算法。
 */
export function PaperDetail({ payload, paper, onFocusPaper, onClear }: PaperDetailProps) {
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  const [abstractOpen, setAbstractOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // 换一篇论文,所有展开态回到默认:摘要收起、分组全收
  useEffect(() => {
    setOpenEdge(null);
    setAbstractOpen(false);
    setOpenGroup(null);
  }, [paper.id]);

  const paperById = new Map(
    payload.graph.nodes.filter((n) => n.kind === "paper").map((n) => [n.id, n]),
  );

  const relations = payload.graph.edges.filter(
    (e) => e.layer !== "derived" && (e.source === paper.id || e.target === paper.id),
  );

  const citationCount = relations.filter((e) => e.kind === "CITES").length;

  /**
   * 按关系类型分组。
   *
   * 一篇论文可能连着几十条边,平铺成一张长列表时,"有几类关系"这件事
   * 反而被淹没了。分组之后标题本身就是目录:引用 23 / 基线 3 / 同期 5……
   * 每一组再单独展开。
   */
  const groups = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    for (const e of relations) {
      const list = map.get(e.kind) ?? [];
      list.push(e);
      map.set(e.kind, list);
    }
    const rank = (kind: string) => (kind === "CITES" ? 1 : 0);
    return [...map.entries()]
      .map(([kind, items]) => ({
        kind,
        items: [...items].sort((a, b) => b.confidence - a.confidence),
      }))
      .sort((a, b) => rank(a.kind) - rank(b.kind) || b.items.length - a.items.length);
  }, [relations]);

  const presetLabel = (kind: string): string =>
    payload.presets.find((p) => p.id.toLowerCase() === kind.toLowerCase())?.label ??
    KIND_LABEL[kind] ??
    kind;

  return (
    <div className="flex flex-col gap-3.5">
      <header>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-[14px] leading-snug text-ink">{paper.title}</h2>
          <button
            type="button"
            onClick={onClear}
            className="mt-0.5 shrink-0 text-[11px] text-ink-4 transition-colors hover:text-ink-2"
          >
            收起
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-4">
          <span>{paper.year || "年份未知"}</span>
          <span>被引 {paper.citations.toLocaleString()}</span>
          {paper.venue ? <span className="max-w-[190px] truncate">{paper.venue}</span> : null}
        </div>

        {paper.authors.length ? (
          <p className="mt-2 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">
            {paper.authors.map((a) => a.name).join(" · ")}
          </p>
        ) : null}
      </header>

      {paper.abstract ? (
        <section>
          <div className="flex items-baseline justify-between gap-2">
            <SectionTitle>摘要</SectionTitle>
            <button
              type="button"
              onClick={() => setAbstractOpen((v) => !v)}
              aria-expanded={abstractOpen}
              className="group flex items-center gap-1 text-[10.5px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink-2"
            >
              {abstractOpen ? "收起" : "展开"}
              <svg
                width="9"
                height="9"
                viewBox="0 0 10 10"
                aria-hidden="true"
                className={`transition-transform duration-[var(--dur-fast)] ${abstractOpen ? "rotate-180" : ""}`}
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
          </div>
          {/*
            收起时保留约三行的高度并向下渐隐:既给出"这里还有内容"的提示,
            又不让一段几十行的摘要把关系列表推到屏幕外。
          */}
          <div
            className="mt-1.5"
            style={
              abstractOpen
                ? undefined
                : { maskImage: "linear-gradient(to bottom, #000 62%, transparent 100%)" }
            }
          >
            <Collapsible open={abstractOpen} collapsedHeight={64}>
              <p className="text-[12px] leading-[1.75] text-ink-2">{paper.abstract}</p>
            </Collapsible>
          </div>
        </section>
      ) : null}

      <section>
        <SectionTitle>
          关系{relations.length ? ` · ${relations.length}` : ""}
        </SectionTitle>

        {relations.length === 0 ? (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-4">
            这篇论文在星空里暂时没有连出的边。可以推近查看它的邻近星体,或把它设为种子。
          </p>
        ) : (
          <div className="mt-1.5 flex flex-col gap-1">
            {groups.map(({ kind, items }) => {
              const isOpen = openGroup === kind;
              return (
                <div key={kind} className="rounded-lg border border-hair">
                  {/* 组头:类型 + 条数 + 箭头。每一组单独展开 */}
                  <button
                    type="button"
                    onClick={() => setOpenGroup(isOpen ? null : kind)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hair/40"
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border"
                      style={{
                        borderColor: toneOfKind(kind),
                        borderStyle: kind === "CONTEMPORARY_OF" ? "dashed" : "solid",
                      }}
                    />
                    <span className="text-[10.5px] tracking-[0.06em] text-ink-3">
                      {presetLabel(kind)}
                    </span>
                    <span className="font-mono text-[9.5px] text-ink-4">{items.length}</span>
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 10 10"
                      aria-hidden="true"
                      className={`ml-auto text-ink-4 transition-transform duration-[var(--dur-fast)] ${isOpen ? "rotate-180" : ""}`}
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

                  <Collapsible open={isOpen}>
                    <ul className="flex flex-col border-t border-hair px-1.5 py-1.5">
                      {items.slice(0, 40).map((edge) => {
                        const otherId = edge.source === paper.id ? edge.target : edge.source;
                        const other = paperById.get(otherId);
                        const edgeOpen = openEdge === edge.id;

                        return (
                          <li key={edge.id}>
                            <button
                              type="button"
                              onClick={() => setOpenEdge(edgeOpen ? null : edge.id)}
                              aria-expanded={edgeOpen}
                              className={`w-full rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
                                edgeOpen ? "bg-hair/40" : "hover:bg-hair/30"
                              }`}
                            >
                              <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-2">
                                {other?.kind === "paper" ? other.title : otherId}
                              </span>
                            </button>

                            <Collapsible open={edgeOpen}>
                              <div className="px-2 pt-1 pb-2">
                                <Provenance edge={edge} />
                                {edge.rationale ? (
                                  <p className="mt-1.5 text-[11.5px] leading-[1.7] text-ink-2">
                                    {edge.rationale}
                                  </p>
                                ) : null}
                                {edge.evidence.length ? (
                                  <ul className="mt-2 flex flex-col gap-1.5">
                                    {edge.evidence.map((ev, i) => (
                                      <EvidenceCard key={i} evidence={ev} />
                                    ))}
                                  </ul>
                                ) : null}
                                {other?.kind === "paper" ? (
                                  <button
                                    type="button"
                                    onClick={() => onFocusPaper(other.id)}
                                    className="mt-2 text-[10.5px] text-accent/80 transition-colors hover:text-accent"
                                  >
                                    在星图中定位 →
                                  </button>
                                ) : null}
                              </div>
                            </Collapsible>
                          </li>
                        );
                      })}
                      {items.length > 40 ? (
                        <li className="px-2 py-1 font-mono text-[9.5px] text-ink-4">
                          另有 {items.length - 40} 条未列出
                        </li>
                      ) : null}
                    </ul>
                  </Collapsible>
                </div>
              );
            })}
          </div>
        )}

        {citationCount > 0 ? (
          <p className="mt-2 font-mono text-[10px] text-ink-4">
            其中 {citationCount} 条为引用关系(来自 OpenAlex,可公开核验)
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onFocusPaper(paper.id)}
          className="text-[10.5px] text-accent/80 transition-colors hover:text-accent"
        >
          聚焦这篇论文 →
        </button>
        {paper.doi || paper.urls.landing ? (
          <a
            href={paper.urls.landing ?? paper.doi}
            target="_blank"
            rel="noreferrer"
            className="text-[10.5px] text-ink-4 transition-colors hover:text-ink-2"
          >
            原文 ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] tracking-[0.16em] text-ink-4 uppercase">{children}</h3>
  );
}

/**
 * 判定来源。
 *
 * 界面上必须能一眼看出「这是大模型说的」还是「这是算法算的」——
 * 两者的可信度不同,呈现方式也不该相同。
 */
function Provenance({ edge }: { edge: GraphEdge }) {
  const src = edge.provenance;
  const isLlm = src.source === "llm";
  const isAlgorithm = src.source === "algorithm";

  const text = isLlm
    ? `模型判定 · ${src.promptVersion ?? "未标注版本"}`
    : isAlgorithm
      ? "启发式判定 · 未配置大模型"
      : `数据源 · ${src.source}`;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`rounded-full border px-1.5 py-px text-[9.5px] ${
          isLlm ? "border-accent/40 text-accent" : "border-hair-2 text-ink-4"
        }`}
      >
        {text}
      </span>
      {!isLlm && !isAlgorithm ? null : (
        <span className="font-mono text-[9.5px] text-ink-4">
          置信度 {(edge.confidence * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: Evidence }) {
  if (evidence.kind === "span") {
    return (
      <li className="rounded-md border-l-2 border-hair-2 bg-hair/40 py-1.5 pl-2.5">
        <div className="font-mono text-[9.5px] tracking-[0.08em] text-ink-4 uppercase">
          原文 · {evidence.section}
        </div>
        <blockquote className="mt-1 text-[11.5px] leading-[1.7] text-ink-2">
          “{evidence.quote}”
        </blockquote>
      </li>
    );
  }

  if (evidence.kind === "citation") {
    return (
      <li className="rounded-md border-l-2 border-hair-2 bg-hair/40 py-1.5 pl-2.5">
        <div className="font-mono text-[9.5px] tracking-[0.08em] text-ink-4 uppercase">
          引用记录
        </div>
        <p className="mt-1 font-mono text-[10.5px] text-ink-3">
          {evidence.paperId.replace("paper:", "")} → {evidence.cites.replace("paper:", "")}
        </p>
      </li>
    );
  }

  if (evidence.kind === "metadata") {
    return (
      <li className="rounded-md border-l-2 border-hair-2 bg-hair/40 py-1.5 pl-2.5">
        <div className="font-mono text-[9.5px] tracking-[0.08em] text-ink-4 uppercase">
          结构化依据
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">{evidence.note}</p>
      </li>
    );
  }

  if (evidence.kind === "embedding") {
    return (
      <li className="rounded-md border-l-2 border-hair-2 bg-hair/40 py-1.5 pl-2.5">
        <div className="font-mono text-[9.5px] tracking-[0.08em] text-ink-4 uppercase">
          向量相似度
        </div>
        <p className="mt-1 font-mono text-[10.5px] text-ink-3">
          {evidence.similarity.toFixed(3)}
        </p>
      </li>
    );
  }

  return (
    <li className="rounded-md border-l-2 border-hair-2 bg-hair/40 py-1.5 pl-2.5">
      <div className="font-mono text-[9.5px] tracking-[0.08em] text-ink-4 uppercase">
        统计检验 · {evidence.test}
      </div>
      <p className="mt-1 font-mono text-[10.5px] text-ink-3">
        统计量 {evidence.statistic.toFixed(3)}
        {evidence.pValue !== undefined ? ` · p=${evidence.pValue.toFixed(4)}` : ""}
      </p>
    </li>
  );
}

const KIND_LABEL: Record<string, string> = {
  CITES: "引用",
  BASELINE_OF: "基线",
  CONTEMPORARY_OF: "同期",
  SIMILAR_APPROACH: "思路类似",
  ALTERNATIVE_TO: "同任务异方法",
  EXTENDS: "扩展",
  CONTRADICTS: "结论矛盾",
  MENTIONS: "提及",
  SEMANTIC_NEIGHBOR: "语义近邻",
  POTENTIAL_LINK: "潜在连接",
};

function toneOfKind(kind: string): string {
  switch (kind) {
    case "CONTRADICTS":
      return "var(--alert)";
    case "ALTERNATIVE_TO":
      return "var(--warm)";
    case "SIMILAR_APPROACH":
    case "EXTENDS":
      return "var(--accent)";
    case "BASELINE_OF":
      return "var(--ink-2)";
    default:
      return "var(--ink-4)";
  }
}
