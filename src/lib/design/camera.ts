/**
 * 相机 —— 世界坐标与屏幕坐标之间的唯一翻译层。
 *
 * 缩放不是「把同一张图放大」,而是**切换抽象层级**(语义缩放)。
 * 相机只负责几何变换;「当前处于哪一层」由 viewLevelOf(scale) 判断 ——
 * 两者分开,是为了让渲染层能在过渡期间同时画两层并做交叉淡入。
 */

import type { Vec2 } from "@/types/kg";

export interface Camera {
  /** 世界坐标中落在屏幕中心点上的位置 */
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.06;
export const MAX_SCALE = 4.5;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, scale: 1 };

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** 世界 → 屏幕:screen = (world - camera) * scale + viewport / 2 */
export function worldToScreen(cam: Camera, vw: number, vh: number, p: Vec2): Vec2 {
  return {
    x: (p.x - cam.x) * cam.scale + vw / 2,
    y: (p.y - cam.y) * cam.scale + vh / 2,
  };
}

/** 屏幕 → 世界。 */
export function screenToWorld(cam: Camera, vw: number, vh: number, p: Vec2): Vec2 {
  return {
    x: (p.x - vw / 2) / cam.scale + cam.x,
    y: (p.y - vh / 2) / cam.scale + cam.y,
  };
}

/**
 * 以某个屏幕点为锚点缩放。
 *
 * 这是滚轮缩放手感的关键:锚点下的世界坐标在缩放前后必须保持不动,
 * 否则画面会「跑」,用户会觉得视图在跟自己作对。
 */
export function zoomAt(
  cam: Camera,
  vw: number,
  vh: number,
  anchorScreen: Vec2,
  factor: number,
): Camera {
  const next = clampScale(cam.scale * factor);
  const world = screenToWorld(cam, vw, vh, anchorScreen);
  return {
    // 解 worldToScreen(next, world) === anchorScreen
    x: world.x - (anchorScreen.x - vw / 2) / next,
    y: world.y - (anchorScreen.y - vh / 2) / next,
    scale: next,
  };
}

/** 把相机对准某个世界坐标点(用当前缩放)。 */
export function focusOn(cam: Camera, target: Vec2, scale = cam.scale): Camera {
  return { x: target.x, y: target.y, scale: clampScale(scale) };
}

/**
 * 让给定的世界包围盒刚好装进视口。
 *
 * 星系聚焦、加载完成后的初始视角都走这里 —— 保证「无论星空多大,
 * 打开就能看见全部」,而不是打开先看到一片空白。
 */
export function fitBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  vw: number,
  vh: number,
  padding = 140,
): Camera {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const h = Math.max(1, bounds.maxY - bounds.minY);
  const scale = clampScale(Math.min((vw - padding * 2) / w, (vh - padding * 2) / h));
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    scale,
  };
}

/**
 * 指数平滑地逼近目标相机。
 *
 * 用「每秒收敛比例」而不是「每帧固定步长」:这样在 60Hz 与 120Hz 屏上
 * 动画时长一致 —— 这也是全项目「按秒不按帧」约定的由来。
 */
export function lerpCamera(from: Camera, to: Camera, dt: number, speed = 6): Camera {
  const k = 1 - Math.exp(-speed * dt);
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    scale: from.scale + (to.scale - from.scale) * k,
  };
}

export function cameraClose(a: Camera, b: Camera, eps = 0.0008): boolean {
  return (
    Math.abs(a.x - b.x) < eps * Math.max(1, Math.abs(b.x)) &&
    Math.abs(a.y - b.y) < eps * Math.max(1, Math.abs(b.y)) &&
    Math.abs(a.scale - b.scale) < 0.0008
  );
}
