"use client";

import { useMemo } from "react";

import { BuildStatus } from "@/components/shell/BuildStatus";
import { PaperDetail } from "@/components/shell/PaperDetail";
import { SeedConfirm } from "@/components/shell/SeedConfirm";
import { SeedSearch } from "@/components/shell/SeedSearch";
import { useStarfieldStore } from "@/stores/starfield-store";

interface AssistantRailProps {
  onFocusPaper: (id: string) => void;
  /** 当前构建阶段的说明文案 */
  buildLabel: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * 右侧研究助手栏。
 *
 * 全站只有这一个侧栏,没有标签页。原因是这四种内容
 * (输入种子 / 确认候选 / 等待构建 / 查看论文)在时间上是**互斥**的,
 * 用户同一时刻只会关心其中一件。做成标签页等于让用户自己去选,
 * 而系统其实知道现在该给他看什么。
 */
export function AssistantRail({
  onFocusPaper,
  buildLabel,
  collapsed,
  onToggleCollapse,
}: AssistantRailProps) {
  const payload = useStarfieldStore((s) => s.payload);
  const phase = useStarfieldStore((s) => s.phase);
  const candidates = useStarfieldStore((s) => s.candidates);
  const query = useStarfieldStore((s) => s.query);
  const error = useStarfieldStore((s) => s.error);
  const selectedId = useStarfieldStore((s) => s.selectedId);
  const capabilities = useStarfieldStore((s) => s.capabilities);
  const streamProgress = useStarfieldStore((s) => s.streamProgress);
  const setQuery = useStarfieldStore((s) => s.setQuery);
  const search = useStarfieldStore((s) => s.search);
  const grow = useStarfieldStore((s) => s.grow);
  const setSelected = useStarfieldStore((s) => s.setSelected);
  const dismissCandidates = useStarfieldStore((s) => s.dismissCandidates);

  const selectedPaper = useMemo(() => {
    if (!payload || !selectedId) return null;
    const node = payload.graph.nodes.find((n) => n.id === selectedId);
    return node?.kind === "paper" ? node : null;
  }, [payload, selectedId]);

  const busy = phase === "resolving" || phase === "growing";

  return (
    <aside
      className="pointer-events-auto fixed top-0 right-0 z-30 flex h-dvh flex-col border-l border-hair bg-bg/80 backdrop-blur-[2px] transition-transform duration-[--dur-base]"
      style={{
        width: 372,
        transform: collapsed ? "translateX(100%)" : "translateX(0)",
      }}
      aria-label="研究助手"
    >
      <header className="flex items-center justify-between border-b border-hair px-5 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[12px] tracking-[0.1em] text-ink">AI 研究助手</h1>
          <span className="font-mono text-[9.5px] tracking-[0.1em] text-ink-4 uppercase">
            OpenAlex · arXiv
          </span>
        </div>
        <div className="flex items-center gap-2">
          {capabilities ? (
            <span
              title={
                capabilities.llm
                  ? `已连接 ${capabilities.llmModel ?? "大模型"}`
                  : "未配置大模型密钥:关系判定将使用启发式规则,并在结果里如实标注"
              }
              className={`rounded-full border px-1.5 py-px text-[9.5px] ${
                capabilities.llm ? "border-accent/40 text-accent" : "border-warm/40 text-warm"
              }`}
            >
              {capabilities.llm ? "模型已连接" : "启发式模式"}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="收起侧栏"
            className="grid h-5 w-5 place-items-center rounded text-ink-4 transition-colors hover:text-ink-2"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
              <path
                d="M4 1.8 L8.2 5.5 L4 9.2"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="border-b border-hair px-5 py-3.5">
        <SeedSearch
          value={query}
          busy={busy}
          growing={Boolean(payload)}
          onChange={setQuery}
          onSubmit={() => void search()}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {error ? (
          <div className="mb-4 rounded-lg border border-alert/30 px-3 py-2.5">
            <p className="text-[12px] text-alert">{error.message}</p>
            {error.hint ? (
              <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">{error.hint}</p>
            ) : null}
          </div>
        ) : null}

        {phase === "growing" || phase === "resolving" ? (
          <BuildStatus
            label={buildLabel}
            step={phase === "growing" ? 3 : 1}
            total={4}
            detail={
              streamProgress
                ? `第 ${streamProgress.round}/${streamProgress.depth} 层 · 已判定 ${streamProgress.judged} 对论文 · 找到 ${streamProgress.matched} 条关系 · ${streamProgress.llmCalls} 次模型调用`
                : undefined
            }
          />
        ) : phase === "confirming" ? (
          <SeedConfirm
            candidates={candidates}
            onPick={(c) => void grow(c.id)}
            onDismiss={dismissCandidates}
          />
        ) : selectedPaper && payload ? (
          <PaperDetail
            payload={payload}
            paper={selectedPaper}
            onFocusPaper={onFocusPaper}
            onClear={() => setSelected(null)}
          />
        ) : (
          <EmptyState hasPayload={Boolean(payload)} />
        )}
      </div>

      {payload ? (
        <footer className="border-t border-hair px-5 py-3">
          <div className="flex flex-col gap-1.5 font-mono text-[10px] text-ink-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{payload.graph.stats.papers} 篇</span>
              <span>{payload.graph.stats.edges} 条边</span>
              <span>{(payload.meta.durationMs / 1000).toFixed(1)}s</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                {payload.meta.capabilities.llm
                  ? `模型调用 ${payload.meta.relations.llmCalls} 次 · 约 ${(
                      payload.meta.relations.estimatedTokens / 1000
                    ).toFixed(1)}k token`
                  : "未使用模型"}
              </span>
              {payload.meta.relations.cacheHits > 0 ? (
                <span className="text-accent/70">
                  命中缓存 {payload.meta.relations.cacheHits} 对
                </span>
              ) : null}
              {payload.meta.relations.rejectedQuotes > 0 ? (
                <span>{payload.meta.relations.rejectedQuotes} 条引用被核验拦下</span>
              ) : null}
            </div>
          </div>
        </footer>
      ) : null}
    </aside>
  );
}

function EmptyState({ hasPayload }: { hasPayload: boolean }) {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="text-[12.5px] leading-[1.85] text-ink-2">
        {hasPayload
          ? "点击任意星体查看它的论文详情与关系证据,或者在输入框里并入下一篇种子论文。"
          : "输入一篇种子论文,星空会沿着它的研究脉络长出来 —— 引用是引力线,关系是行星。"}
      </p>
      <ul className="flex flex-col gap-2 border-t border-hair pt-3">
        {[
          ["滚轮", "缩放；拉远看领域星云,推近看论文星体"],
          ["拖拽", "平移整片星空"],
          ["双击星体", "聚焦并推近"],
          ["⌘K", "跳到种子输入框"],
        ].map(([k, v]) => (
          <li key={k} className="flex items-baseline gap-3 text-[11px]">
            <span className="w-[62px] shrink-0 font-mono text-ink-3">{k}</span>
            <span className="text-ink-4">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
