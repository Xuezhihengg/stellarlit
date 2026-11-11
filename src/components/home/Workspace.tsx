"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { HomeView } from "@/components/home/HomeView";
import { StarfieldCanvasView } from "@/components/shell/StarfieldCanvasView";
import { useTheme } from "@/hooks/use-theme";
import { useSession } from "@/hooks/use-session";
import { useStarfieldStore } from "@/stores/starfield-store";

type View = "home" | "to-canvas" | "canvas" | "to-home";

/** 与 globals.css 里的 .home-layer / .canvas-layer 动画时长保持一致。 */
const ENTER_MS = 860;
const EXIT_MS = 820;
const WARP_MS = 1_120;

interface WorkspaceProps {
  initialStarfieldId: string | null;
  initialSeed: string;
  autoStart: boolean;
}

/**
 * 首页与星图画布的共同外壳。
 *
 * 两者不换路由,而是同一条时间线上的前后两幕:
 * 首页淡出时画布已经从下方浮起,中间用一层很淡的光晕把两次曝光接住。
 * 这样输入种子后的反馈是「进入星空」,而不是「打开另一个页面」。
 */
export function Workspace({ initialStarfieldId, initialSeed, autoStart }: WorkspaceProps) {
  const { theme, toggleTheme } = useTheme();
  const { user } = useSession();
  const [view, setView] = useState<View>(() =>
    initialStarfieldId ? "canvas" : "home",
  );
  const [canvasMounted, setCanvasMounted] = useState(Boolean(initialStarfieldId));
  /**
   * 登录前输入的种子只续建一次。
   *
   * 路由参数会一直留在服务端 props 里;如果直接把它传给首页,
   * 用户从画布点「新建」回到首页时会再次命中自动构建。
   * 这里把「待续建的种子」和「首页输入框里的值」拆成两份一次性状态。
   */
  const [homeSeed, setHomeSeed] = useState(initialSeed);
  const [pendingSeed, setPendingSeed] = useState(() =>
    autoStart && !initialStarfieldId ? initialSeed.trim() : "",
  );
  const [warpKey, setWarpKey] = useState(0);
  const [warpVisible, setWarpVisible] = useState(false);
  const timers = useRef<number[]>([]);

  const payload = useStarfieldStore((s) => s.payload);
  const phase = useStarfieldStore((s) => s.phase);
  const candidates = useStarfieldStore((s) => s.candidates);
  const reset = useStarfieldStore((s) => s.reset);
  const setQuery = useStarfieldStore((s) => s.setQuery);
  const search = useStarfieldStore((s) => s.search);
  const grow = useStarfieldStore((s) => s.grow);
  const loadById = useStarfieldStore((s) => s.loadById);
  const loadCapabilities = useStarfieldStore((s) => s.loadCapabilities);

  /** 从首页发起的构建:高置信度时直接落种子,不再让用户多点一次。 */
  const autoGrowRef = useRef(false);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  const after = useCallback((callback: () => void, ms: number) => {
    timers.current.push(window.setTimeout(callback, ms));
  }, []);

  const burstWarp = useCallback(() => {
    setWarpKey((key) => key + 1);
    setWarpVisible(true);
    after(() => setWarpVisible(false), WARP_MS);
  }, [after]);

  const cleanUrl = useCallback(() => {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ["starfield", "seed", "auto"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
  }, []);

  useEffect(() => {
    if (user) void loadCapabilities();
  }, [loadCapabilities, user]);

  useEffect(() => {
    if (!autoGrowRef.current || phase !== "confirming") return;
    const best = candidates[0];
    if (!best) {
      autoGrowRef.current = false;
      return;
    }
    const runnerUp = candidates[1];
    const unambiguous = !runnerUp || best.confidence - runnerUp.confidence >= 0.06;
    if (best.confidence < 0.82 || !unambiguous) {
      // 候选含糊时仍然交还给用户确认 —— 首页的"一键开始"不该变成替人猜论文
      autoGrowRef.current = false;
      return;
    }
    autoGrowRef.current = false;
    void grow(best.id);
  }, [candidates, grow, phase]);

  useEffect(() => {
    if (initialStarfieldId) void loadById(initialStarfieldId);
  }, [initialStarfieldId, loadById]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  /** 构建出第一版结构后把 id 写回 URL,刷新仍能回到这片星空。 */
  useEffect(() => {
    if (!canvasMounted) return;
    if (view !== "canvas" && view !== "to-canvas") return;
    const id = payload?.starfield.id;
    if (!id) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("starfield") === id) return;
    url.searchParams.set("starfield", id);
    url.searchParams.delete("seed");
    url.searchParams.delete("auto");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [canvasMounted, payload?.starfield.id, view]);

  const startFromHome = useCallback(
    (seed: string) => {
      setPendingSeed("");
      setHomeSeed("");
      clearTimers();
      cleanUrl();
      reset();
      setQuery(seed);
      void search();
      autoGrowRef.current = true;

      setCanvasMounted(true);
      setView("to-canvas");
      burstWarp();
      after(() => setView("canvas"), ENTER_MS);
    },
    [after, burstWarp, cleanUrl, clearTimers, reset, search, setQuery],
  );

  const goHome = useCallback(() => {
    autoGrowRef.current = false;
    clearTimers();
    setView("to-home");
    burstWarp();
    after(() => {
      setView("home");
      setCanvasMounted(false);
      setPendingSeed("");
      setHomeSeed("");
      reset();
      cleanUrl();
      // 回到首页后把光标放回种子框(触屏设备不主动弹键盘)
      if (window.matchMedia("(pointer: fine)").matches) {
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[aria-label="种子论文"]')?.focus();
        });
      }
    }, EXIT_MS);
  }, [after, burstWarp, cleanUrl, clearTimers, reset]);

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-bg">
      {view !== "canvas" ? (
        <div
          className="workspace-layer home-layer"
          data-phase={view === "to-canvas" ? "exit" : view === "to-home" ? "enter" : "idle"}
          aria-hidden={view === "to-canvas"}
          inert={view === "to-canvas"}
        >
          <HomeView
            theme={theme}
            onToggleTheme={toggleTheme}
            initialSeed={homeSeed}
            autoStartSeed={pendingSeed}
            onStart={startFromHome}
          />
        </div>
      ) : null}

      {canvasMounted ? (
        <div
          className="workspace-layer canvas-layer"
          data-phase={view === "to-canvas" ? "enter" : view === "to-home" ? "exit" : "idle"}
          aria-hidden={view === "home" || view === "to-home"}
          inert={view === "home" || view === "to-home"}
        >
          <StarfieldCanvasView
            theme={theme}
            onToggleTheme={toggleTheme}
            onNew={goHome}
          />
        </div>
      ) : null}

      {warpVisible ? (
        <div key={warpKey} aria-hidden="true" className="workspace-warp" />
      ) : null}
    </main>
  );
}
