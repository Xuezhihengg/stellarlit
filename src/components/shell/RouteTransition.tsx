"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import {
  PAGE_NAVIGATION_EVENT,
  type PageNavigationDetail,
  type PageNavigationOptions,
} from "@/lib/navigation/transition";

type Phase = "idle" | "covering" | "revealing";

interface PendingNavigation extends PageNavigationDetail {
  fromLocation: string;
}

/** 幕布落下后稍等一帧再切路由,确保旧页真的淡完;露出时给新页留出首帧绘制时间。 */
const COVER_MS = 220;
const REVEAL_MS = 240;
/** 路由异常时不能把整页永久盖住。 */
const SAFETY_MS = 6000;

function RouteTransitionInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const location = query ? `${pathname}?${query}` : pathname;
  const [phase, setPhase] = useState<Phase>("idle");
  const pendingRef = useRef<PendingNavigation | null>(null);
  const coverTimerRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const safetyTimerRef = useRef<number | null>(null);

  const clearTimer = useCallback((timer: React.MutableRefObject<number | null>) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer(coverTimerRef);
    clearTimer(revealTimerRef);
    clearTimer(safetyTimerRef);
    pendingRef.current = null;
    setPhase("idle");
  }, [clearTimer]);

  const start = useCallback(
    (href: string, options: PageNavigationOptions = {}): boolean => {
      if (pendingRef.current) return true;

      const target = new URL(href, window.location.href);
      if (target.origin !== window.location.origin) return false;

      const sameLocation =
        target.pathname === window.location.pathname && target.search === window.location.search;
      if (sameLocation) {
        if (options.refresh) router.refresh();
        return true;
      }

      const destination = `${target.pathname}${target.search}${target.hash}`;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reducedMotion) {
        if (options.replace) router.replace(destination);
        else router.push(destination);
        if (options.refresh) router.refresh();
        return true;
      }

      pendingRef.current = {
        href: destination,
        fromLocation: `${window.location.pathname}${window.location.search}`,
        replace: options.replace,
        refresh: options.refresh,
      };
      setPhase("covering");

      coverTimerRef.current = window.setTimeout(() => {
        if (options.replace) router.replace(destination);
        else router.push(destination);
        if (options.refresh) router.refresh();
      }, COVER_MS);

      safetyTimerRef.current = window.setTimeout(reset, SAFETY_MS);
      return true;
    },
    [router, reset],
  );

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || phase !== "covering" || location === pending.fromLocation) return;
    clearTimer(coverTimerRef);
    setPhase("revealing");
  }, [location, phase, clearTimer]);

  useEffect(() => {
    if (phase !== "revealing") return;
    revealTimerRef.current = window.setTimeout(reset, REVEAL_MS);
    return () => clearTimer(revealTimerRef);
  }, [phase, reset, clearTimer]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      // 自己接管过场动画的入口(如画布顶栏的品牌:回首页由 Workspace 换幕)
      if (anchor.dataset.skipTransition === "true") return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      if (start(url.href)) event.preventDefault();
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [start]);

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<PageNavigationDetail>).detail;
      if (!detail?.href) return;
      if (start(detail.href, detail)) event.preventDefault();
    };

    window.addEventListener(PAGE_NAVIGATION_EVENT, onNavigate);
    return () => window.removeEventListener(PAGE_NAVIGATION_EVENT, onNavigate);
  }, [start]);

  useEffect(
    () => () => {
      clearTimer(coverTimerRef);
      clearTimer(revealTimerRef);
      clearTimer(safetyTimerRef);
      pendingRef.current = null;
    },
    [clearTimer],
  );

  return <div aria-hidden="true" className="route-veil" data-phase={phase} />;
}

export function RouteTransition() {
  return (
    <Suspense fallback={null}>
      <RouteTransitionInner />
    </Suspense>
  );
}
