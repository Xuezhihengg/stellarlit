"use client";

import { useEffect, useRef } from "react";

import { hexA, PALETTES, type CanvasPalette } from "@/lib/design/palette";
import type { Theme } from "@/hooks/use-theme";

type Point = [number, number];

interface StarNode {
  x: number;
  y: number;
  r: number;
  alpha: number;
  warm: boolean;
  glow: number;
  phase: number;
  twinkle: number;
  twinkleSpeed: number;
}

interface Edge {
  a: Point;
  b: Point;
  warm: boolean;
  alpha: number;
  width: number;
}

interface Pulse {
  a: Point;
  b: Point;
  warm: boolean;
  phase: number;
  speed: number;
  size: number;
}

interface Scene {
  stars: StarNode[];
  twinklers: StarNode[];
  edges: Edge[];
  pulses: Pulse[];
}

const TAU = Math.PI * 2;

const ANCHORS: Array<[number, number, number, boolean]> = [
  [0.12, 0.2, 6.4, false],
  [0.88, 0.16, 5.2, true],
  [0.84, 0.81, 6.8, false],
  [0.08, 0.84, 4.8, true],
  [0.68, 0.72, 3.6, false],
  [0.26, 0.54, 3.2, false],
];

/**
 * 首页星空。
 *
 * 不再是几条长星流,而是一张由大量圆点星核组成的星图:
 * 大小夸张的星点彼此连线,动态层只负责沿线脉冲和闪烁。
 * 静态星野与连线只绘制一次,因此视觉更密但不会拖慢首页。
 */
export function HeroSky({ theme }: { theme: Theme }) {
  const staticRef = useRef<HTMLCanvasElement>(null);
  const dynamicRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const staticCanvas = staticRef.current;
    const dynamicCanvas = dynamicRef.current;
    if (!staticCanvas || !dynamicCanvas) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let scene: Scene = { stars: [], twinklers: [], edges: [], pulses: [] };
    let sprites: { accent: HTMLCanvasElement; warm: HTMLCanvasElement } | null = null;
    let raf = 0;
    let lastFrame = 0;
    const startedAt = performance.now();

    const resize = () => {
      const rect = staticCanvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      scene = paintStatic(staticCanvas, width, height, dpr, theme);
      sprites = {
        accent: makeGlowSprite(PALETTES[theme].accent),
        warm: makeGlowSprite(PALETTES[theme].warm),
      };
      paintDynamic(dynamicCanvas, width, height, dpr, theme, 0, scene, sprites);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - lastFrame < 1000 / 55) return;
      lastFrame = now;
      if (sprites) {
        paintDynamic(dynamicCanvas, width, height, dpr, theme, (now - startedAt) / 1000, scene, sprites);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(staticCanvas);
    resize();
    if (!reduceMotion) raf = requestAnimationFrame(frame);

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [theme]);

  return (
    <div aria-hidden="true" className="home-hero-sky">
      <canvas ref={staticRef} className="home-hero-canvas home-hero-canvas-static" />
      <canvas ref={dynamicRef} className="home-hero-canvas home-hero-canvas-dynamic" />
    </div>
  );
}

function paintStatic(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, theme: Theme): Scene {
  const ctx = prepareCanvas(canvas, width, height, dpr);
  const palette = PALETTES[theme];

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);
  paintNebulae(ctx, width, height, palette, theme);

  const scene = makeScene(width, height);
  paintEdges(ctx, scene.edges, palette, theme);
  paintStars(ctx, scene.stars, palette);
  return scene;
}

function paintNebulae(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: CanvasPalette,
  theme: Theme,
) {
  const dark = theme === "dark";
  ctx.save();
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  drawEllipseGlow(ctx, width * 0.18, height * 0.76, width * 0.32, height * 0.22, palette.warm, dark ? 0.045 : 0.026, -0.3);
  drawEllipseGlow(ctx, width * 0.82, height * 0.22, width * 0.34, height * 0.22, palette.accent, dark ? 0.065 : 0.04, -0.3);
  drawEllipseGlow(ctx, width * 0.7, height * 0.72, width * 0.25, height * 0.16, palette.accent, dark ? 0.032 : 0.02, 0.24);
  drawEllipseGlow(ctx, width * 0.5, height * 0.5, width * 0.34, height * 0.26, palette.accent, dark ? 0.035 : 0.022, -0.1);
  ctx.restore();
}

function makeScene(width: number, height: number): Scene {
  const rand = mulberry32(0x51f15e);
  const target = Math.round(Math.min(190, Math.max(72, (width * height) / 7000)));
  const stars: StarNode[] = [];
  const minDistance = Math.min(width, height) * 0.033;
  const maxDistance = Math.min(width, height) * 0.22;
  const minDistanceSq = minDistance * minDistance;
  let attempts = 0;

  while (stars.length < target && attempts < target * 36) {
    attempts += 1;
    const x = rand() * width;
    const y = rand() * height;
    if (insideCalm(x, y, width, height) && rand() < 0.44) continue;

    let tooClose = false;
    for (const star of stars) {
      const dx = star.x - x;
      const dy = star.y - y;
      if (dx * dx + dy * dy < minDistanceSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const tier = rand();
    const large = tier > 0.955;
    const medium = tier > 0.79 && !large;
    const r = large ? 5 + rand() * 3.5 : medium ? 2.4 + rand() * 2.2 : 1 + rand() * 1.15;
    const centerDx = (x - width * 0.5) / (width * 0.45);
    const centerDy = (y - height * 0.5) / (height * 0.32);
    const quiet = centerDx * centerDx + centerDy * centerDy < 1;
    stars.push({
      x,
      y,
      r,
      alpha: (large ? 0.88 : 0.34 + rand() * 0.52) * (quiet ? 0.58 : 1),
      warm: rand() > 0.88,
      glow: r * (large ? 9 + rand() * 5 : medium ? 5.5 + rand() * 4 : 2.8 + rand() * 2.2),
      phase: rand() * TAU,
      twinkle: 0.16 + rand() * 0.46,
      twinkleSpeed: 0.3 + rand() * 1.1,
    });
  }

  for (const [nx, ny, r, warm] of ANCHORS) {
    stars.push({
      x: nx * width,
      y: ny * height,
      r,
      alpha: 0.98,
      warm,
      glow: r * 13,
      phase: rand() * TAU,
      twinkle: 0.24 + rand() * 0.3,
      twinkleSpeed: 0.28 + rand() * 0.6,
    });
  }

  const edges: Edge[] = [];
  const pulses: Pulse[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < stars.length; i++) {
    const source = stars[i]!;
    const candidates: Array<{ index: number; distance: number }> = [];
    for (let j = 0; j < stars.length; j++) {
      if (i === j) continue;
      const target = stars[j]!;
      const distance = Math.hypot(target.x - source.x, target.y - source.y);
      if (distance > minDistance * 1.4 && distance < maxDistance) {
        candidates.push({ index: j, distance });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates.slice(0, 4)) {
      const key = i < candidate.index ? `${i}:${candidate.index}` : `${candidate.index}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const target = stars[candidate.index]!;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const calm = insideCalm(midX, midY, width, height);
      if (calm && rand() < 0.58) continue;

      const warm = source.warm || target.warm;
      const strong = source.r > 3 || target.r > 3;
      const edgeIndex = edges.length;
      edges.push({
        a: [source.x, source.y],
        b: [target.x, target.y],
        warm,
        alpha: ((warm ? 0.12 : 0.075) + rand() * 0.08 + (strong ? 0.035 : 0)) * (calm ? 0.34 : 1),
        width: 0.38 + rand() * 0.55 + (strong ? 0.25 : 0),
      });

      if (edgeIndex % 3 === 0) {
        pulses.push({
          a: [source.x, source.y],
          b: [target.x, target.y],
          warm,
          phase: rand(),
          speed: 0.055 + rand() * 0.075,
          size: 15 + rand() * 12 + (strong ? 5 : 0),
        });
      }
    }
  }

  return {
    stars,
    twinklers: stars.filter((_, index) => index % 4 === 0),
    edges,
    pulses,
  };
}

function paintEdges(ctx: CanvasRenderingContext2D, edges: Edge[], palette: CanvasPalette, theme: Theme) {
  ctx.save();
  for (const edge of edges) {
    ctx.strokeStyle = hexA(edge.warm ? palette.warm : palette.accent, edge.alpha * (theme === "dark" ? 1 : 0.62));
    ctx.lineWidth = edge.width;
    ctx.beginPath();
    ctx.moveTo(edge.a[0], edge.a[1]);
    ctx.lineTo(edge.b[0], edge.b[1]);
    ctx.stroke();
  }
  ctx.restore();
}

function paintStars(ctx: CanvasRenderingContext2D, stars: StarNode[], palette: CanvasPalette) {
  ctx.save();
  for (const star of stars) {
    if (star.glow > 0) {
      const color = star.warm ? palette.warm : palette.accent;
      const gradient = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.glow);
      gradient.addColorStop(0, hexA(color, star.alpha * 0.38));
      gradient.addColorStop(0.34, hexA(color, star.alpha * 0.11));
      gradient.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.glow, 0, TAU);
      ctx.fill();
    }

    ctx.globalAlpha = star.alpha;
    ctx.fillStyle = star.warm ? palette.warm : palette.ink;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function paintDynamic(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  theme: Theme,
  time: number,
  scene: Scene,
  sprites: { accent: HTMLCanvasElement; warm: HTMLCanvasElement },
) {
  const ctx = prepareCanvas(canvas, width, height, dpr);
  const palette = PALETTES[theme];
  const dark = theme === "dark";

  ctx.save();
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";

  ctx.fillStyle = palette.ink;
  for (const star of scene.twinklers) {
    const shimmer = (Math.sin(time * star.twinkleSpeed + star.phase) + 1) * 0.5;
    ctx.globalAlpha = star.twinkle * (0.1 + shimmer * 0.5) * (dark ? 1 : 0.55);
    ctx.beginPath();
    ctx.arc(star.x, star.y, Math.max(0.9, star.r), 0, TAU);
    ctx.fill();
  }

  for (const pulse of scene.pulses) {
    const u = (((time * pulse.speed + pulse.phase) % 1) + 1) % 1;
    const envelope = smoothstep01(Math.min(u / 0.16, (1 - u) / 0.16));
    if (envelope < 0.004) continue;

    const x = pulse.a[0] + (pulse.b[0] - pulse.a[0]) * u;
    const y = pulse.a[1] + (pulse.b[1] - pulse.a[1]) * u;
    const breathe = 0.92 + Math.sin(time * 2.4 + pulse.phase * TAU) * 0.08;
    const size = pulse.size * breathe * (0.7 + envelope * 0.3);
    const sprite = pulse.warm ? sprites.warm : sprites.accent;
    const distance = Math.hypot(pulse.b[0] - pulse.a[0], pulse.b[1] - pulse.a[1]) || 1;
    const trailU = Math.max(0, u - Math.min(0.12, 34 / distance));
    const trailX = pulse.a[0] + (pulse.b[0] - pulse.a[0]) * trailU;
    const trailY = pulse.a[1] + (pulse.b[1] - pulse.a[1]) * trailU;

    ctx.strokeStyle = pulse.warm ? palette.warm : palette.accent;
    ctx.globalAlpha = (dark ? 0.34 : 0.18) * breathe * envelope;
    ctx.lineWidth = 1.35;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trailX, trailY);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.globalAlpha = (dark ? 0.96 : 0.56) * breathe * envelope;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);

    const trailSize = size * 0.56;
    ctx.globalAlpha = (dark ? 0.5 : 0.28) * breathe * envelope;
    ctx.drawImage(sprite, trailX - trailSize / 2, trailY - trailSize / 2, trailSize, trailSize);

    ctx.globalAlpha = (dark ? 0.98 : 0.62) * envelope;
    ctx.fillStyle = palette.ink;
    ctx.beginPath();
    ctx.arc(x, y, 1.9 * (0.55 + envelope * 0.45), 0, TAU);
    ctx.fill();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function insideCalm(x: number, y: number, width: number, height: number) {
  const dx = (x - width * 0.5) / (width * 0.43);
  const dy = (y - height * 0.5) / (height * 0.28);
  return dx * dx + dy * dy < 1;
}

function smoothstep01(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function drawEllipseGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  alpha: number,
  rotation: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.scale(rx / Math.max(1, ry), 1);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
  gradient.addColorStop(0, hexA(color, alpha));
  gradient.addColorStop(0.42, hexA(color, alpha * 0.42));
  gradient.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, ry, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function makeGlowSprite(color: string): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = 64;
  sprite.height = 64;
  const ctx = sprite.getContext("2d");
  if (!ctx) return sprite;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, hexA(color, 0.94));
  gradient.addColorStop(0.16, hexA(color, 0.52));
  gradient.addColorStop(0.48, hexA(color, 0.13));
  gradient.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return sprite;
}

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number) {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
