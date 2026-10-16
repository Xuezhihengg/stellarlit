"use client";

import { useEffect, useRef } from "react";

import { PALETTES } from "@/lib/design/palette";
import type { Theme } from "@/hooks/use-theme";

/** 一层星尘里的一粒。位置用世界坐标(0-1 归一化),与画布尺寸解耦。 */
interface Dust {
  nx: number;
  ny: number;
  /** 视差深度 0-1:越大越"近",动得越多,因此越亮越大。 */
  depth: number;
  size: number;
  /** 相位偏移,让闪烁不同步。 */
  phase: number;
  twinkle: number;
}

interface StarfieldCanvasProps {
  theme: Theme;
  /** 星尘密度系数。演示与截图时可以调低,让图谱本身更突出。 */
  density?: number;
  className?: string;
}

const DUST_COUNT = 520;
const PARALLAX_STRENGTH = 26;
const DRIFT_SPEED = 0.004; // 单位:世界宽度/秒

/**
 * 背景星空。
 *
 * 它只做一件事:让画面有纵深。所有的**信息**都在图谱层上,
 * 因此这里的星尘刻意压到几乎看不见 —— 背景一旦抢眼,前景的数据就不可信了。
 *
 * 性能约定(见 docs/前端工程规范.md):
 *   - 动画按秒计算,不按帧计数,刷新率无关
 *   - dt 上限 64ms,防止切回标签页时星尘"跳"一下
 *   - 尺寸与主题变化才重建,其余全在 rAF 里
 */
export function StarfieldCanvas({ theme, density = 1, className }: StarfieldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 指针位置用 ref 传递:它每帧都变,走 state 会把整棵子树拖下水。 */
  const pointerRef = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 });
  const themeRef = useRef<Theme>(theme);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- 星尘:用确定性伪随机生成,刷新后分布一致,不"重新洗牌" ----
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };

    const dust: Dust[] = [];
    for (let i = 0; i < DUST_COUNT; i++) {
      const depth = rand();
      dust.push({
        nx: rand(),
        ny: rand(),
        depth,
        size: 0.35 + depth * 1.15,
        phase: rand() * Math.PI * 2,
        twinkle: 0.35 + rand() * 0.5,
      });
    }

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const onPointerMove = (e: PointerEvent) => {
      pointerRef.current.tx = e.clientX / Math.max(1, window.innerWidth);
      pointerRef.current.ty = e.clientY / Math.max(1, window.innerHeight);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    let raf = 0;
    let last = performance.now();
    let elapsed = 0;

    const frame = (now: number) => {
      // 上限 64ms:切标签页回来时 dt 可能是好几秒,不夹住就会瞬移
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;
      elapsed += dt;

      const palette = PALETTES[themeRef.current];
      const pointer = pointerRef.current;
      // 指针做一次指数平滑,否则鼠标一动星尘就"抖"
      pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3);
      pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, width, height);

      // 一层几乎看不见的底光:给"深空"一点方向感,而不是纯黑
      const glowX = width * (0.5 + (pointer.x - 0.5) * 0.06);
      const glowY = height * (0.42 + (pointer.y - 0.5) * 0.06);
      const glow = ctx.createRadialGradient(
        glowX,
        glowY,
        0,
        glowX,
        glowY,
        Math.max(width, height) * 0.75,
      );
      glow.addColorStop(0, palette.nebula);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      ctx.globalCompositeOperation = palette.blend;
      const drift = reduceMotion ? 0 : elapsed * DRIFT_SPEED;

      for (const d of dust) {
        // 缓慢漂移:每个粒子有自己的速度,整体看不出"同一张背景在平移"
        const px = ((d.nx + drift * (0.3 + d.depth)) % 1 + 1) % 1;
        const py = d.ny;

        const ox = (pointer.x - 0.5) * PARALLAX_STRENGTH * d.depth;
        const oy = (pointer.y - 0.5) * PARALLAX_STRENGTH * d.depth;
        const x = px * width - ox;
        const y = py * height - oy;

        // 闪烁:每个粒子独立相位,且越"远"的越安静
        const flicker = reduceMotion
          ? 1
          : 0.72 + 0.28 * Math.sin(elapsed * 0.6 + d.phase) * d.twinkle;
        const alpha = (0.06 + d.depth * 0.16) * flicker * density;

        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.dust;
        ctx.beginPath();
        ctx.arc(x, y, d.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [density]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1,
        display: "block",
        // canvas 是替换元素:`inset:0` 不会把它拉伸开,必须显式给尺寸,
        // 否则它保持 300x150 的固有尺寸,而 devicePixelRatio 缩放又会反向放大这个固有尺寸
        width: "100%",
        height: "100%",
      }}
      aria-hidden="true"
    />
  );
}
