"use client";

import { useCallback, useEffect, useState } from "react";

import { AssistantRail } from "@/components/shell/AssistantRail";
import { BottomBar } from "@/components/shell/BottomBar";
import { BrandMark } from "@/components/shell/BrandMark";
import { RelationLegend } from "@/components/shell/RelationLegend";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { TopBar } from "@/components/shell/TopBar";
import { Metric } from "@/components/ui/Metric";
import { NavLinks } from "@/components/shell/NavLinks";
import { StarfieldCanvas } from "@/components/star-map/StarfieldCanvas";
import { StarMap } from "@/components/star-map/StarMap";
import { useTheme } from "@/hooks/use-theme";
import { levelHint } from "@/lib/graph/scene";
import { useStarfieldStore } from "@/stores/starfield-store";
import type { ViewLevel } from "@/types/starfield";

const RAIL_WIDTH = 372;

/**
 * 主界面。
 *
 * 这个文件的职责只有「组装」:把星空、图谱、外壳摆到位,把状态接上。
 * 任何一块逻辑长到需要解释时,它就该搬到 components/ 或 lib/ 里去 ——
 * 页面一旦变成逻辑的家,后面每次改动都要先读懂它。
 */
export default function StarfieldPage() {
  const { theme, toggleTheme } = useTheme();

  const payload = useStarfieldStore((s) => s.payload);
  const selectedId = useStarfieldStore((s) => s.selectedId);
  const hiddenKinds = useStarfieldStore((s) => s.hiddenKinds);
  const minYear = useStarfieldStore((s) => s.minYear);
  const phase = useStarfieldStore((s) => s.phase);
  const query = useStarfieldStore((s) => s.query);
  const setSelected = useStarfieldStore((s) => s.setSelected);
  const toggleKind = useStarfieldStore((s) => s.toggleKind);
  const setMinYear = useStarfieldStore((s) => s.setMinYear);
  const loadCapabilities = useStarfieldStore((s) => s.loadCapabilities);
  const loadById = useStarfieldStore((s) => s.loadById);

  const [level, setLevel] = useState<ViewLevel>("paper");
  const [collapsed, setCollapsed] = useState(false);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  /**
   * 深链:`/?starfield=<id>` 直接打开某一片星空。
   *
   * 用 window.location 而不是 useSearchParams,是为了避免为了一个可选参数
   * 把整页拖进 Suspense 边界。历史页跳转与演示时的截图直达都靠它。
   */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("starfield");
    if (id) void loadById(id);
  }, [loadById]);

  const focusPaper = useCallback(
    (id: string) => {
      setSelected(id);
      setFocus({ id, nonce: Date.now() });
    },
    [setSelected],
  );

  const buildLabel =
    phase === "resolving"
      ? "正在解析这篇论文"
      : phase === "growing"
        ? "正在展开引文邻域"
        : "准备中";

  const lastSeedId = payload?.starfield.seeds.at(-1)?.paperId;
  const lastSeed = lastSeedId
    ? payload?.graph.nodes.find((n) => n.id === lastSeedId)
    : undefined;

  return (
    <main className="relative h-dvh w-screen overflow-hidden">
      <StarfieldCanvas theme={theme} density={payload ? 0.7 : 1} />

      <StarMap
        payload={payload}
        selectedId={selectedId}
        hiddenKinds={hiddenKinds}
        minYear={minYear}
        theme={theme}
        rightInset={collapsed ? 0 : RAIL_WIDTH}
        focus={focus}
        onSelect={setSelected}
        onViewLevelChange={setLevel}
      />

      <TopBar
        brand={<BrandMark />}
        title={lastSeed?.kind === "paper" ? lastSeed.title : "还没有星空"}
        meta={
          payload
            ? `${payload.starfield.seeds.length} 篇种子 · 最近并入`
            : query
              ? "确认候选中"
              : "等待输入种子论文"
        }
        right={
          <>
            {payload ? (
              <div className="hidden items-center gap-4 lg:flex">
                <Metric label="PAPERS" value={payload.graph.stats.papers} />
                <Metric label="RELATIONS" value={payload.graph.stats.byLayer.semantic} />
                <Metric label="FRONTIERS" value={payload.graph.stats.communities} />
              </div>
            ) : null}
            <NavLinks />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </>
        }
        rightInset={collapsed ? 0 : RAIL_WIDTH}
      />

      <AssistantRail
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onFocusPaper={focusPaper}
        buildLabel={buildLabel}
      />

      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="展开侧栏"
          className="group fixed top-1/2 right-0 z-30 -translate-y-1/2 rounded-l-lg border border-r-0 border-hair-2 bg-bg/85 px-1.5 py-5 backdrop-blur-sm"
        >
          <span className="flex flex-col items-center gap-2">
            <span className="[writing-mode:vertical-rl] text-[10.5px] tracking-[0.16em] text-ink-3 transition-colors group-hover:text-accent">
              研究助手
            </span>
            <span className="h-1 w-1 rounded-full bg-accent" />
          </span>
        </button>
      ) : null}

      <BottomBar
        payload={payload}
        viewHint={levelHint(level)}
        minYear={minYear}
        rightInset={collapsed ? 0 : RAIL_WIDTH}
        onMinYearChange={setMinYear}
        legend={
          payload ? (
            <RelationLegend
              payload={payload}
              hiddenKinds={hiddenKinds}
              onToggle={toggleKind}
            />
          ) : null
        }
      />
    </main>
  );
}
