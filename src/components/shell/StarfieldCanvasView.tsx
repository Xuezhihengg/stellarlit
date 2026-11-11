"use client";

import { useCallback, useState } from "react";

import { AssistantRail } from "@/components/shell/AssistantRail";
import { AccountMenu } from "@/components/shell/AccountMenu";
import { BottomBar } from "@/components/shell/BottomBar";
import { BrandMark } from "@/components/shell/BrandMark";
import { QuotaNotice } from "@/components/shell/QuotaNotice";
import { RelationLegend } from "@/components/shell/RelationLegend";
import { SeedSearch } from "@/components/shell/SeedSearch";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { TopBar } from "@/components/shell/TopBar";
import { Metric } from "@/components/ui/Metric";
import { StarfieldCanvas } from "@/components/star-map/StarfieldCanvas";
import { StarMap } from "@/components/star-map/StarMap";
import type { Theme } from "@/hooks/use-theme";
import { formatPaperTitle } from "@/lib/format";
import { useStarfieldStore } from "@/stores/starfield-store";
import type { ViewLevel } from "@/types/starfield";

/** 浮窗宽 372 + 右侧留白 16:星图自适应视角时要让出的宽度 */
const RAIL_WIDTH = 388;

/**
 * 主界面。
 *
 * 这个文件的职责只有「组装」:把星空、图谱、外壳摆到位,把状态接上。
 * 任何一块逻辑长到需要解释时,它就该搬到 components/ 或 lib/ 里去 ——
 * 页面一旦变成逻辑的家,后面每次改动都要先读懂它。
 */
export function StarfieldCanvasView({
  theme,
  onToggleTheme,
  onNew,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onNew: () => void;
}) {
  const payload = useStarfieldStore((s) => s.payload);
  const selectedId = useStarfieldStore((s) => s.selectedId);
  const dimmedKinds = useStarfieldStore((s) => s.dimmedKinds);
  const minYear = useStarfieldStore((s) => s.minYear);
  const phase = useStarfieldStore((s) => s.phase);
  const streamProgress = useStarfieldStore((s) => s.streamProgress);
  const query = useStarfieldStore((s) => s.query);
  const setQuery = useStarfieldStore((s) => s.setQuery);
  const search = useStarfieldStore((s) => s.search);
  const setSelected = useStarfieldStore((s) => s.setSelected);
  const toggleKind = useStarfieldStore((s) => s.toggleKind);
  const setMinYear = useStarfieldStore((s) => s.setMinYear);
  const [, setLevel] = useState<ViewLevel>("paper");
  const [collapsed, setCollapsed] = useState(false);
  const [focus, setFocus] = useState<{ ids: string[]; nonce: number } | null>(null);

  const focusPapers = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      setSelected(ids[0] ?? null);
      setFocus({ ids, nonce: Date.now() });
    },
    [setSelected],
  );

  const focusPaper = useCallback(
    (id: string) => focusPapers([id]),
    [focusPapers],
  );

  const buildLabel =
    phase === "resolving"
      ? "正在解析这篇论文"
      : phase === "growing"
        ? "正在展开引文邻域"
        : phase === "settling"
          ? "星图构建完成,正在收拢视图"
          : "准备中";

  const lastSeedId = payload?.starfield.seeds.at(-1)?.paperId;
  const lastSeed = lastSeedId
    ? payload?.graph.nodes.find((n) => n.id === lastSeedId)
    : undefined;

  const showBuildState =
    !payload && (phase === "resolving" || phase === "confirming" || phase === "growing");
  const buildStateTitle =
    phase === "confirming"
      ? "请确认要构建的论文"
      : phase === "growing"
        ? "正在展开引文邻域"
        : "正在定位种子论文";
  const buildStateDetail =
    phase === "confirming"
      ? "右侧列出候选,选择后这片星空会开始生长"
      : phase === "growing"
        ? `第 ${streamProgress?.round ?? 1} 轮 · 已判定 ${streamProgress?.judged ?? 0} 对`
        : "检索标题、摘要与匹配记录";

  const buildSteps = [
    { label: "解析种子论文", hint: "识别标题、arXiv ID 或 DOI" },
    { label: "核对目标论文", hint: "按标题、年份与来源交叉确认" },
    { label: "展开引文邻域", hint: "先落结构骨架,再逐条判定关系" },
  ] as const;
  const activeBuildStep =
    phase === "growing" ? 2 : phase === "confirming" ? 1 : 0;

  return (
    <main className="relative h-full w-full overflow-hidden">
      <StarfieldCanvas theme={theme} density={payload ? 0.7 : 1} />

      <StarMap
        payload={payload}
        selectedId={selectedId}
        dimmedKinds={dimmedKinds}
        minYear={minYear}
        theme={theme}
        rightInset={collapsed ? 0 : RAIL_WIDTH}
        focus={focus}
        onSelect={setSelected}
        // 双击星星 = "我要看这篇的详情":侧栏收着就顺手打开
        onStarDoubleClick={() => setCollapsed(false)}
        // 侧栏开着时,单击直接聚焦(详情就在手边,不用再点一次按钮)
        focusOnSelect={!collapsed}
        onViewLevelChange={setLevel}
      />

      <div
        aria-hidden={!showBuildState}
        className="canvas-build-state absolute inset-y-0 left-0 z-10 flex items-center justify-center"
        data-visible={showBuildState}
        style={{ right: collapsed ? 0 : RAIL_WIDTH }}
      >
        <div className="flex -translate-y-3 flex-col items-center text-center">
          <div className="canvas-build-seed" aria-hidden="true">
            <span className="canvas-build-orbit" />
            <span className="canvas-build-orbit canvas-build-orbit-2" />
            <span className="canvas-build-halo" />
            <svg width="17" height="17" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 0.5 L8.1 5.9 L13.5 7 L8.1 8.1 L7 13.5 L5.9 8.1 L0.5 7 L5.9 5.9 Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <p className="mt-7 text-[13px] tracking-[0.02em] text-ink-2">{buildStateTitle}</p>
          <p className="mt-2 max-w-[330px] truncate font-mono text-[9.5px] tracking-[0.06em] text-ink-4">
            {query || "SEED"}
          </p>

          <ol className="canvas-build-steps mt-8" aria-label="构建进度">
            {buildSteps.map((step, index) => {
              const state =
                index < activeBuildStep
                  ? "done"
                  : index === activeBuildStep
                    ? "active"
                    : "pending";
              return (
                <li
                  key={step.label}
                  className="canvas-build-step"
                  data-state={state}
                  style={{ transitionDelay: `${index * 45}ms` }}
                >
                  <span className="canvas-build-mark" aria-hidden="true">
                    {state === "done" ? (
                      <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                        <path
                          d="M1.2 5.2 3.7 7.6 8.8 2.4"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <span className="canvas-build-dot" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="canvas-build-label">{step.label}</span>
                    <span className="canvas-build-hint">
                      {index === activeBuildStep ? buildStateDetail : step.hint}
                    </span>
                  </span>
                  <span className="canvas-build-status">
                    {state === "done" ? "完成" : state === "active" ? "进行中" : "等待"}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <QuotaNotice rightInset={collapsed ? 0 : RAIL_WIDTH} />

      <TopBar
        brand={<BrandMark />}
        title={lastSeed?.kind === "paper" ? formatPaperTitle(lastSeed.title) : "还没有星空"}
        search={
          <SeedSearch
            value={query}
            busy={phase === "resolving" || phase === "growing"}
            growing={Boolean(payload)}
            bare
            onChange={setQuery}
            onSubmit={() => void search()}
          />
        }
        right={
          <>
            {/* 指标是次要信息:窄屏让位给大标题与输入框 */}
            {payload ? (
              <div className="hidden items-center gap-4 min-[1400px]:flex">
                <Metric label="篇论文" value={payload.graph.stats.papers} />
                <Metric label="条关系" value={payload.graph.stats.byLayer.semantic} />
                <Metric label="个前沿" value={payload.graph.stats.communities} />
              </div>
            ) : null}
            {payload ? (
              <button
                type="button"
                onClick={onNew}
                title="新建星空"
                aria-label="新建星空"
                className="flex h-7 items-center gap-1.5 rounded-full border border-hair-2 px-2.5 text-[10.5px] tracking-[0.03em] text-ink-3 transition-[color,border-color,background-color] duration-[var(--dur-fast)] hover:border-accent/40 hover:bg-accent/6 hover:text-accent"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path
                    d="M5 1.4v7.2M1.4 5h7.2"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="hidden min-[980px]:inline">新建</span>
              </button>
            ) : null}
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <AccountMenu />
          </>
        }
        rightInset={collapsed ? 0 : RAIL_WIDTH}
      />

      <AssistantRail
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onFocusPaper={focusPaper}
        onFocusPapers={focusPapers}
        buildLabel={buildLabel}
      />

      <BottomBar
        payload={payload}
        minYear={minYear}
        rightInset={collapsed ? 0 : RAIL_WIDTH}
        onMinYearChange={setMinYear}
        legend={
          payload ? (
            <RelationLegend
              payload={payload}
              dimmedKinds={dimmedKinds}
              onToggle={toggleKind}
            />
          ) : null
        }
      />
    </main>
  );
}
