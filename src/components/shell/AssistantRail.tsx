"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AskPanel } from "@/components/shell/AskPanel";
import { BuildStatus } from "@/components/shell/BuildStatus";
import {
  DEFAULT_PAPER_SIDEBAR_STATE,
  PaperDetail,
  type PaperSidebarState,
} from "@/components/shell/PaperDetail";
import { SeedConfirm } from "@/components/shell/SeedConfirm";
import { useStarfieldStore } from "@/stores/starfield-store";

interface AssistantRailProps {
  onFocusPaper: (id: string) => void;
  /** 关系依据:两篇论文一起聚焦 */
  onFocusPapers?: (ids: string[]) => void;
  /** 当前构建阶段的说明文案 */
  buildLabel: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/**
 * 右侧观星台。
 *
 * 全站只有这一个侧栏,没有标签页。原因是这四种内容
 * (输入种子 / 确认候选 / 等待构建 / 查看论文)在时间上是**互斥**的,
 * 用户同一时刻只会关心其中一件。做成标签页等于让用户自己去选,
 * 而系统其实知道现在该给他看什么。
 */
export function AssistantRail({
  onFocusPaper,
  onFocusPapers,
  buildLabel,
  collapsed,
  onToggleCollapse,
}: AssistantRailProps) {
  const payload = useStarfieldStore((s) => s.payload);
  const phase = useStarfieldStore((s) => s.phase);
  const candidates = useStarfieldStore((s) => s.candidates);
  const error = useStarfieldStore((s) => s.error);
  const selectedId = useStarfieldStore((s) => s.selectedId);
  const streamProgress = useStarfieldStore((s) => s.streamProgress);
  const setQuery = useStarfieldStore((s) => s.setQuery);
  const search = useStarfieldStore((s) => s.search);
  const grow = useStarfieldStore((s) => s.grow);
  const dismissCandidates = useStarfieldStore((s) => s.dismissCandidates);

  const selectedPaper = useMemo(() => {
    if (!payload || !selectedId) return null;
    const node = payload.graph.nodes.find((n) => n.id === selectedId);
    return node?.kind === "paper" ? node : null;
  }, [payload, selectedId]);

  const [tab, setTab] = useState<"detail" | "ask">("detail");
  const [sidebarByPaper, setSidebarByPaper] = useState<
    Record<string, PaperSidebarState>
  >({});
  const detailScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0;
  }, [selectedId]);

  const updatePaperSidebar = (
    paperId: string,
    patch: Partial<PaperSidebarState>,
  ) => {
    setSidebarByPaper((current) => {
      const previous = current[paperId] ?? DEFAULT_PAPER_SIDEBAR_STATE;
      return {
        ...current,
        [paperId]: { ...previous, ...patch },
      };
    });
  };

  return (
    <>
      <aside
      /**
       * 浮窗而不是吸附面板。
       *
       * 吸附面板会把画布切掉一条,整片星空从此"少了一块";
       * 浮窗让星图完整地铺满整屏,面板像一张浮在星空上的纸 ——
       * 这更贴合"星图是主角、助手是旁白"的关系。
       */
      className="pointer-events-auto fixed top-4 right-4 bottom-4 z-30 flex flex-col overflow-hidden rounded-2xl border border-hair-2 bg-bg/78 shadow-[0_24px_70px_-30px_rgba(0,0,0,0.85)] backdrop-blur-xl transition-[transform,opacity] duration-[var(--dur-slow)]"
      style={{
        width: 372,
        transformOrigin: "right center",
        transform: collapsed
          ? "translateX(calc(100% + 20px)) scale(0.985)"
          : "translateX(0) scale(1)",
        opacity: collapsed ? 0 : 1,
        // 收起时不能被点到(它已经滑出画面,但仍在布局里)
        pointerEvents: collapsed ? "none" : "auto",
        transitionTimingFunction: "var(--ease-out)",
      }}
      aria-label="观星台"
    >
      {/*
        标题位置直接就是切换滑钮。

        之前是"标题一行 + 标签一行":同一个面板名出现两次,还多占四十像素。
        现在标题退场,滑钮本身就是这一栏的标题 —— 当前激活的是哪一页,
        一眼就能看出来。
      */}
      <header className="flex items-center justify-between gap-3 border-b border-hair px-6 py-4">
        <div
          className="relative grid flex-1 grid-cols-2 rounded-lg border border-hair bg-bg/40 p-0.5"
          role="tablist"
          aria-label="观星台视图"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-0.25rem)] rounded-md bg-hair-2/50 transition-transform duration-[var(--dur-base)]"
            style={{
              transform:
                tab === "detail" ? "translateX(0)" : "translateX(calc(100% + 0.25rem))",
              transitionTimingFunction: "var(--ease-out)",
            }}
          />
          <button
            type="button"
            role="tab"
            aria-selected={tab === "detail"}
            onClick={() => setTab("detail")}
            className={`relative z-10 rounded-md py-1.5 text-[11px] tracking-[0.04em] transition-colors duration-[var(--dur-fast)] ${
              tab === "detail" ? "text-ink" : "text-ink-4 hover:text-ink-2"
            }`}
          >
            观星台
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "ask"}
            onClick={() => setTab("ask")}
            className={`relative z-10 rounded-md py-1.5 text-[11px] tracking-[0.04em] transition-colors duration-[var(--dur-fast)] ${
              tab === "ask" ? "text-ink" : "text-ink-4 hover:text-ink-2"
            }`}
          >
            文献问答
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {/*
          两页都**常驻在 DOM 里**,靠透明度交叉切换:
          切换时旧内容先淡出、新内容同时淡入;滚动位置、展开态、问答记录
          都不会因为切标签而丢。inert 让隐藏页不可聚焦、不可点击。
        */}
        <div
          ref={detailScrollRef}
          className={`absolute inset-0 overflow-y-auto px-6 py-5 transition-opacity duration-[var(--dur-base)] ${
            tab === "detail" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{ transitionTimingFunction: "var(--ease-out)" }}
          aria-hidden={tab !== "detail"}
          inert={tab !== "detail"}
        >
            {/* 额度是全局状态,由页面上的 QuotaNotice 显示;侧栏只留"这次操作"的错误 */}
            {error && error.code !== "quota" ? (
              <div className="mb-4 rounded-lg border border-alert/30 px-3 py-2.5">
                <p className="text-[12px] text-alert">{error.message}</p>
                {error.hint ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
                    {error.hint}
                  </p>
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
                key={selectedPaper.id}
                payload={payload}
                paper={selectedPaper}
                onFocusPaper={onFocusPaper}
                sidebar={
                  sidebarByPaper[selectedPaper.id] ?? DEFAULT_PAPER_SIDEBAR_STATE
                }
                onUpdateSidebar={updatePaperSidebar}
              />
            ) : (
              <EmptyState hasPayload={Boolean(payload)} />
            )}
        </div>

        {/* 问答:同样保持挂载,切回观星台再回来时答案还在 */}
        <div
          className={`absolute inset-0 overflow-y-auto px-6 py-5 transition-opacity duration-[var(--dur-base)] ${
            tab === "ask" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{ transitionTimingFunction: "var(--ease-out)" }}
          aria-hidden={tab !== "ask"}
          inert={tab !== "ask"}
        >
          {payload ? (
            <AskPanel
              payload={payload}
              onFocusSource={(source) => onFocusPapers?.(source.paperIds)}
              onAddPaper={(title) => {
                // 复用"解析 → 候选确认 → 并入"的既有流程,最终是否加入由用户点选
                setQuery(title);
                void search();
                setTab("detail");
              }}
            />
          ) : (
            <p className="text-[11.5px] leading-relaxed text-ink-4">
              先在顶部输入一篇种子论文。问答只检索当前这片星空里的内容。
            </p>
          )}
        </div>
      </div>

      {payload ? (
        <footer className="border-t border-hair px-6 py-4">
          <div className="flex flex-col gap-2 font-mono text-[10px] text-ink-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{payload.graph.stats.papers} 篇</span>
              <span>{payload.graph.stats.edges} 条边</span>
              <span>{(payload.meta.durationMs / 1000).toFixed(1)}s</span>
              {/* 标题栏让给滑钮后,数据来源挪到这里:不抢位置,但仍在 */}
              <span className="tracking-[0.08em] text-ink-4/80">OpenAlex · arXiv</span>
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
            </div>
          </div>
        </footer>
      ) : null}
      </aside>

      {/*
        开关做成圆形浮窗,骑在侧栏左边缘上。

        位置只有两个:开着时一半压在面板左缘、一半浮在星空里;
        收起后停在屏幕右缘。两者用同一段缓出过渡连起来,
        读起来是"这个按钮跟着面板走",而不是两个按钮在互换。

        它刻意放在 <aside> **外面**:放进去就会跟着面板一起滑出屏幕,
        收起之后就再也点不开了。
      */}
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? "展开观星台" : "收起观星台"}
        aria-expanded={!collapsed}
        className="group fixed top-1/2 z-40 grid h-[38px] w-[38px] place-items-center rounded-full border border-hair-2 bg-bg/90 text-ink-3 shadow-[0_10px_28px_-14px_rgba(0,0,0,0.9)] backdrop-blur-md hover:border-ink-4 hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        style={{
          right: collapsed ? 18 : 384,
          transform: collapsed ? "translate(0, -50%)" : "translate(50%, -50%)",
          /**
           * 位移跟侧栏同速(620ms);颜色仍用快档(160ms)——
           * 悬停反馈不该等半秒。两段时长写在同一行里,
           * 因为内联 transition 会整体覆盖类名上的 transition。
           */
          transition:
            "right var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out), color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
        }}
      >
        {/*
          悬停说明:一个只有 < / > 的圆钮,含义得靠试。
          说明文字向左浮出、只占悬停与键盘聚焦时 —— 平时不占视觉。
        */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-full mr-3 translate-x-1 whitespace-nowrap rounded-md border border-hair-2 bg-bg/92 px-2.5 py-1 text-[10.5px] tracking-[0.04em] text-ink-2 opacity-0 shadow-[0_8px_22px_-12px_rgba(0,0,0,0.85)] backdrop-blur-md transition-[opacity,transform] duration-[var(--dur-fast)] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
        >
          {collapsed ? "展开观星台" : "收起观星台"}
        </span>

        {/* 图标自己再吃一层悬停/按压缩放:位移归按钮,手感归图标 */}
        <span className="grid place-items-center transition-transform duration-[var(--dur-fast)] group-hover:scale-110 group-active:scale-95">
          <svg
            width="13"
            height="13"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={`transition-transform duration-[var(--dur-base)] ${collapsed ? "rotate-180" : ""}`}
            style={{ transitionTimingFunction: "var(--ease-out)" }}
          >
            <path
              d="M6.2 1.5 L2.4 5 L6.2 8.5"
              stroke="currentColor"
              strokeWidth="1.35"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
    </>
  );
}

function EmptyState({ hasPayload }: { hasPayload: boolean }) {
  return (
    <div className="flex flex-col gap-5 pt-1">
      <p className="text-[12.5px] leading-[2] text-ink-2">
        {hasPayload
          ? "点击任意星体查看它的论文详情与关系证据;要并入下一篇种子,用顶部的输入框。"
          : "在顶部输入一篇种子论文,星空会沿着它的研究脉络长出来 —— 引用是引力线,关系是行星。"}
      </p>
      <ul className="flex flex-col gap-2.5 border-t border-hair pt-5">
        {[
          ["滚轮", "缩放；拉远看领域星云,推近看论文星体"],
          ["拖拽", "平移整片星空"],
          ["双击星体", "聚焦并推近"],
          ["⌘K", "跳到顶部种子输入框"],
        ].map(([k, v]) => (
          <li key={k} className="flex items-baseline gap-3">
            <span className="w-[56px] shrink-0 rounded border border-hair-2 px-1.5 py-0.5 text-center font-mono text-[10px] text-ink-3">
              {k}
            </span>
            <span className="text-[11px] leading-relaxed text-ink-4">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
