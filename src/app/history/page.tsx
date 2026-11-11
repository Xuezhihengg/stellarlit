"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { drawScene } from "@/components/star-map/render";
import { GhostButton } from "@/components/ui/GhostButton";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { deleteStarfield, getStarfield, listStarfields } from "@/lib/api/client";
import { fitBounds } from "@/lib/design/camera";
import { PALETTES } from "@/lib/design/palette";
import { buildScene } from "@/lib/graph/scene";
import type { StarfieldPayload } from "@/types/api";
import type { StarfieldSummary } from "@/types/starfield";
import { viewLevelOf } from "@/types/starfield";

/**
 * 历史星空。
 *
 * 一片星空会随着不断并入种子而长期存在,所以历史页不是一张普通表格 ——
 * 用户需要先认出「哪片星云」,再决定打开哪一片。预览用真实布局压成轻量快照,
 * 比任何统计数字都更快地建立这种记忆。
 */
export default function HistoryPage() {
  const { theme } = useTheme();
  const [items, setItems] = useState<StarfieldSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listStarfields();
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await deleteStarfield(id);
      setItems((prev) => (prev ? prev.filter((item) => item.id !== id) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <SecondaryPage
      title="历史星空"
      actions={
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] text-ink-4">
            {items === null ? "读取中" : `${items.length} 片`}
          </span>
          <GhostButton size="sm" onClick={() => void refresh()}>
            刷新
          </GhostButton>
        </div>
      }
    >
      {error ? (
        <p className="mb-5 rounded-lg border border-alert/30 px-3 py-2 text-[12px] text-alert">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <HistorySkeleton />
      ) : items.length === 0 ? (
        <div className="relative overflow-hidden rounded-2xl border border-hair bg-surface/20 px-8 py-16 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{
              background:
                "radial-gradient(55% 90% at 50% 25%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 75%)",
            }}
          />
          <div className="relative">
            <EmptyConstellation />
            <p className="mt-5 text-[13px] text-ink-2">还没有保存过星空</p>
            <p className="mx-auto mt-2 max-w-[360px] text-[11.5px] leading-relaxed text-ink-4">
              回到首页，输入一篇种子论文。构建出的星云会保存在这里，随时可以回来继续。
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-accent/30 px-4 py-1.5 text-[11.5px] text-accent transition-colors duration-[var(--dur-fast)] hover:border-accent/55 hover:bg-accent/8"
            >
              去建第一片星空 <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <StarfieldCard
              key={item.id}
              item={item}
              theme={theme}
              busy={busyId === item.id}
              onDelete={() => void onDelete(item.id)}
            />
          ))}
        </div>
      )}
    </SecondaryPage>
  );
}

function StarfieldCard({
  item,
  theme,
  busy,
  onDelete,
}: {
  item: StarfieldSummary;
  theme: Theme;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <article
      className={`group relative overflow-hidden rounded-2xl border border-hair bg-surface/20 transition-[border-color,background-color,opacity] duration-[var(--dur-fast)] hover:border-accent/25 hover:bg-surface/35 ${
        busy ? "pointer-events-none opacity-45" : ""
      }`}
    >
      <Link
        href={`/?starfield=${encodeURIComponent(item.id)}`}
        className="block rounded-2xl outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <div className="relative aspect-[100/44] overflow-hidden border-b border-hair">
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(72% 100% at 50% 46%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 78%)",
            }}
          />
          <StarfieldThumbnail id={item.id} version={item.updatedAt} theme={theme} />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface/55 to-transparent"
          />
        </div>

        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <h2 className="min-w-0 truncate text-[14px] text-ink transition-colors duration-[var(--dur-fast)] group-hover:text-accent">
              {item.name}
            </h2>
            <time className="shrink-0 pt-0.5 font-mono text-[9.5px] text-ink-4">
              {formatRelativeTime(item.updatedAt)}
            </time>
          </div>

          <p className="mt-2 truncate text-[10.5px] text-ink-4">
            {item.seedTitles.join(" · ") || "（无种子记录）"}
          </p>

          <div className="mt-5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-[10px] text-ink-4">
              <Stat value={item.stats.papers} label="篇" />
              <span aria-hidden="true" className="h-2.5 w-px bg-hair-2" />
              <Stat value={item.stats.edges} label="边" />
              <span aria-hidden="true" className="h-2.5 w-px bg-hair-2" />
              <Stat value={item.stats.communities} label="前沿" />
            </div>
            <span className="flex items-center gap-1.5 text-[10px] text-ink-4 transition-colors duration-[var(--dur-fast)] group-hover:text-accent">
              打开 <span aria-hidden="true">→</span>
            </span>
          </div>
        </div>
      </Link>

      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        aria-label={`删除${item.name}`}
        title="删除这片星空"
        className="absolute top-3 right-3 z-10 grid h-7 w-7 place-items-center rounded-full border border-hair-2 bg-bg/70 text-ink-4 backdrop-blur-md transition-[opacity,color,border-color] duration-[var(--dur-fast)] hover:border-alert/40 hover:text-alert disabled:cursor-not-allowed sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
      >
        {busy ? (
          <span className="text-[9px]">…</span>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M2.5 3.5h7M4.4 3.5v-1h3.2v1M3.7 3.5l.4 6h3.8l.4-6"
              stroke="currentColor"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </article>
  );
}

const THUMBNAIL_CACHE_LIMIT = 12;
const thumbnailPayloads = new Map<string, Promise<StarfieldPayload>>();

function loadThumbnailPayload(id: string, version: string): Promise<StarfieldPayload> {
  const key = `${id}:${version}`;
  const hit = thumbnailPayloads.get(key);
  if (hit) return hit;

  if (thumbnailPayloads.size >= THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailPayloads.keys().next().value;
    if (oldest) thumbnailPayloads.delete(oldest);
  }

  const request = getStarfield(id).catch((error: unknown) => {
    thumbnailPayloads.delete(key);
    throw error;
  });
  thumbnailPayloads.set(key, request);
  return request;
}

/**
 * 真实星图缩略图。
 *
 * 不另画画法:拿到完整 payload 后复用观星台的 buildScene + drawScene,
 * 只是把相机固定为「装下整片星空」并画一帧静态画面。
 * 卡片进入视口才加载,避免历史很长时一次性下载所有 payload。
 */
function StarfieldThumbnail({
  id,
  version,
  theme,
}: {
  id: string;
  version: string;
  theme: Theme;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [payload, setPayload] = useState<StarfieldPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setFailed(false);
    void loadThumbnailPayload(id, version)
      .then((next) => {
        if (!cancelled) setPayload(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, id, version]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !payload) return;

    const seedIds = new Set(payload.starfield.seeds.map((seed) => seed.paperId));
    const scene = buildScene(payload.graph, payload.layout, seedIds, {
      presets: payload.presets,
    });
    let frame = 0;

    const render = () => {
      frame = 0;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;

      /**
       * 画布内部按屏幕像素密度绘制,再交给 CSS 缩到卡片尺寸。
       *
       * 逻辑坐标始终等于卡片尺寸,只把设备像素密度提高;否则所有坐标
       * 会被同一个放大变换推到画布之外。以 2 倍为上限,22 张卡片的
       * 画布显存也不会失控。
       */
      const renderScale = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
      const renderWidth = rect.width;
      const renderHeight = rect.height;
      const pixelWidth = Math.max(1, Math.round(renderWidth * renderScale));
      const pixelHeight = Math.max(1, Math.round(renderHeight * renderScale));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const palette = PALETTES[theme];
      canvas.style.backgroundColor = palette.bg;
      canvas.style.backgroundImage = `radial-gradient(120% 140% at 50% 45%, ${palette.nebula}, transparent 72%)`;

      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);

      const padding = Math.max(6, Math.min(renderWidth, renderHeight) * 0.05);
      const camera = fitBounds(scene.bounds, renderWidth, renderHeight, padding);
      /**
       * 小图按真实取景铺满卡片;图太大时「装下全部」会让语义缩放
       * 落到领域层,星体和边几乎不可见。此时改用缩略图浓度,仍画完整布局。
       */
      const previewMode = camera.scale < 0.42;

      drawScene(ctx, {
        scene,
        camera,
        width: renderWidth,
        height: renderHeight,
        theme,
        level: viewLevelOf(camera.scale),
        time: 0,
        pointer: { x: 0, y: 0 },
        preview: previewMode,
      });
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [payload, theme]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full transition-opacity duration-[var(--dur-base)] ${
          payload ? "opacity-100" : "opacity-0"
        }`}
      />
      {!payload && !failed ? (
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 animate-pulse bg-hair/12" />
          <div className="absolute top-1/2 left-1/2 h-24 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/5 blur-2xl" />
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-mono text-[9px] tracking-[0.08em] text-ink-4">预览暂不可用</span>
        </div>
      ) : null}
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-mono text-[11px] text-ink-2 tabular-nums">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function HistorySkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="overflow-hidden rounded-2xl border border-hair bg-surface/20">
          <div className="aspect-[100/44] animate-pulse bg-hair/25" />
          <div className="space-y-3 p-5">
            <div className="h-3 w-2/5 animate-pulse rounded-full bg-hair/45" />
            <div className="h-2.5 w-4/5 animate-pulse rounded-full bg-hair/30" />
            <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-hair/25" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyConstellation() {
  return (
    <svg
      width="54"
      height="36"
      viewBox="0 0 54 36"
      fill="none"
      aria-hidden="true"
      className="mx-auto text-accent/45"
    >
      <path
        d="M7 25 18 12l10 9 8-11 11 12"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.45"
      />
      <circle cx="7" cy="25" r="2" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" opacity="0.8" />
      <circle cx="28" cy="21" r="1.8" fill="currentColor" />
      <circle cx="36" cy="10" r="1.2" fill="currentColor" opacity="0.8" />
      <circle cx="47" cy="22" r="2.1" fill="var(--warm)" />
    </svg>
  );
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, now)) return `今天 ${clock}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}
