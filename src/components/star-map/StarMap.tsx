"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  cameraClose,
  clampScale,
  DEFAULT_CAMERA,
  fitBounds,
  lerpCamera,
  screenToWorld,
  zoomAt,
  type Camera,
} from "@/lib/design/camera";
import { buildScene, hitTest, type Scene } from "@/lib/graph/scene";
import type { StarfieldPayload } from "@/types/api";
import type { ViewLevel } from "@/types/starfield";
import { viewLevelOf } from "@/types/starfield";

import { createAnimState, drawScene, stepAnim } from "./render";

/**
 * 初始视角的最低缩放。
 *
 * 「装下全部」在小图上会落在论文层,在大图上会一路缩到领域层 ——
 * 后者打开时是一片几乎全黑的星云,用户第一眼看不到任何论文。
 * 因此初始取景只保证**尽量多**,不保证**全部**:
 * 低于这个缩放时停在能看清星体的层级,让用户自己决定要不要拉远看星云。
 */
const MIN_INITIAL_SCALE = 0.5;

interface StarMapProps {
  payload: StarfieldPayload | null;
  selectedId: string | null;
  dimmedKinds: Set<string>;
  minYear: number | null;
  theme: "dark" | "light";
  /** 右侧被侧栏遮住的像素宽度:自适应视角时要把它让出来 */
  rightInset?: number;
  /** 外部要求把镜头对准某篇论文。nonce 变化即触发,避免同一目标重复聚焦。 */
  focus?: { id: string; nonce: number } | null;
  onSelect: (id: string | null) => void;
  /** 双击某颗星(用于"双击即打开详情侧栏") */
  onStarDoubleClick?: (id: string) => void;
  /** 侧栏展开时,单击星体也顺手聚焦到它 */
  focusOnSelect?: boolean;
  onViewLevelChange?: (level: ViewLevel) => void;
}

interface HoverState {
  id: string | null;
  screenX: number;
  screenY: number;
}

/**
 * 星图渲染层。
 *
 * 这个组件刻意保持「薄」:它只做四件事 —— 维护相机、处理指针、跑 rAF、调 drawScene。
 * 所有几何与语义都在 lib 里,所有界面在 shell 里。它一旦变厚,
 * 就会出现「改一个交互要动渲染代码」的局面。
 *
 * 关于 ref 与 state 的分工(见 docs/前端工程规范.md §3):
 *   相机、指针、悬浮 —— 每帧变化,只走 ref,渲染循环直接读
 *   选中、筛选      —— 低频、跨组件共享,走 store
 */
export function StarMap({
  payload,
  selectedId,
  dimmedKinds,
  minYear,
  theme,
  rightInset = 0,
  focus = null,
  onSelect,
  onStarDoubleClick,
  focusOnSelect = false,
  onViewLevelChange,
}: StarMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const cameraRef = useRef<Camera>({ ...DEFAULT_CAMERA });
  const targetRef = useRef<Camera>({ ...DEFAULT_CAMERA });
  const hoverRef = useRef<HoverState>({ id: null, screenX: 0, screenY: 0 });
  /**
   * 事件监听只挂一次;回调走 ref,父组件每次渲染换个箭头函数也不会
   * 把整组指针监听重新注册一遍。
   */
  const onStarDoubleClickRef = useRef(onStarDoubleClick);
  onStarDoubleClickRef.current = onStarDoubleClick;
  const focusOnSelectRef = useRef(focusOnSelect);
  focusOnSelectRef.current = focusOnSelect;
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  /** 画布尺寸还没测出来时的待办自适应,由首帧补上 */
  const pendingFitRef = useRef<Scene | null>(null);

  const draggingRef = useRef<{ active: boolean; lastX: number; lastY: number; moved: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
    moved: 0,
  });
  /** 归一化指针位置(-0.5~0.5):视差用,每帧变化,只走 ref */
  const pointerRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  /** 逐帧动画状态:淡入淡出、选中入场都靠它,每帧变化,只走 ref */
  const animRef = useRef(createAnimState());

  /** 渲染循环读的是这一份;React 重渲染时替换内容,引用不变。 */
  const liveRef = useRef<{ scene: Scene | null; payload: StarfieldPayload | null; theme: "dark" | "light" }>(
    { scene: null, payload: null, theme },
  );
  /** 渲染循环要读选中项,但它的依赖数组里不能有 selectedId(否则每次点星都重建循环) */
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const scene = useMemo<Scene | null>(() => {
    if (!payload) return null;
    const seedIds = new Set(payload.starfield.seeds.map((s) => s.paperId));
    return buildScene(payload.graph, payload.layout, seedIds, {
      selectedId,
      dimmedKinds,
      minYear,
    });
  }, [payload, selectedId, dimmedKinds, minYear]);

  liveRef.current.scene = scene;
  liveRef.current.payload = payload;
  liveRef.current.theme = theme;

  const rightInsetRef = useRef(rightInset);
  rightInsetRef.current = rightInset;

  /**
   * 把包围盒装进「扣除侧栏之后」的可视区域。
   *
   * 直接用视口中心会让整片星空被侧栏压掉右侧一块,用户看到的构图总是偏的。
   * 这里把相机中心左移半个侧栏宽(换算到世界坐标),让星空落在真正的可视区里。
   */
  const fitIntoView = useCallback((bounds: Scene["bounds"], w: number, h: number): Camera => {
    const inset = Math.min(rightInsetRef.current, w * 0.45);
    const usable = Math.max(80, w - inset);
    const cam = fitBounds(bounds, usable, h, 150);
    const scale = clampScale(Math.max(cam.scale, MIN_INITIAL_SCALE));
    return { ...cam, scale, x: cam.x - inset / 2 / scale };
  }, []);

  // ---------------------------------------------------------------------
  // 新载荷到达时把整片星空装进视口
  // ---------------------------------------------------------------------
  const lastFitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!payload || !scene) return;
    const key = `${payload.starfield.id}:${payload.graph.stats.papers}`;
    if (lastFitRef.current === key) return;
    lastFitRef.current = key;

    const { w, h } = sizeRef.current;
    if (w > 0 && h > 0) {
      const cam = fitIntoView(scene.bounds, w, h);
      cameraRef.current = cam;
      targetRef.current = cam;
    } else {
      // 尺寸还没测出来:先记下意图,首帧再由 render 循环补上
      pendingFitRef.current = scene;
    }
  }, [payload, scene, fitIntoView]);

  // ---------------------------------------------------------------------
  // 外部聚焦请求:把镜头移到目标星体并推近
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!focus || !scene) return;
    const node = scene.nodes.find((n) => n.id === focus.id);
    if (!node) return;
    const inset = rightInsetRef.current;
    const scale = clampScale(Math.max(1.6, cameraRef.current.scale));
    // 目标要落在可视区中心,同样要把侧栏让出来
    targetRef.current = {
      x: node.x + inset / 2 / scale,
      y: node.y,
      scale,
    };
  }, [focus, scene]);

  // ---------------------------------------------------------------------
  // 画布尺寸
  // ---------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------
  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { w, h } = sizeRef.current;
      if (!w || !h) return;

      // 触控板的像素级滚动与鼠标的粗格滚动量级差很多,先归一化
      const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-raw * 0.0016);
      targetRef.current = zoomAt(targetRef.current, w, h, localPoint(e), factor);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      draggingRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, moved: 0 };
      canvas.style.cursor = "grabbing";
    };

    const onPointerMove = (e: PointerEvent) => {
      // 视差:指针位置做一次指数平滑,否则鼠标一动整片星空就"抖"
      const { w: vw, h: vh } = sizeRef.current;
      if (vw && vh) {
        pointerRef.current.tx = e.clientX / vw - 0.5;
        pointerRef.current.ty = e.clientY / vh - 0.5;
      }

      const drag = draggingRef.current;
      if (drag.active) {
        const dx = e.clientX - drag.lastX;
        const dy = e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);

        const cam = cameraRef.current;
        cameraRef.current = { ...cam, x: cam.x - dx / cam.scale, y: cam.y - dy / cam.scale };
        targetRef.current = { ...cameraRef.current };
        return;
      }

      // 悬浮检测:命中半径随缩放放宽,缩小时也点得中
      const scene = liveRef.current.scene;
      const { w, h } = sizeRef.current;
      if (!scene || !w || !h) return;

      const pt = localPoint(e);
      const world = screenToWorld(cameraRef.current, w, h, pt);
      const hit = hitTest(scene, world.x, world.y, cameraRef.current.scale);
      const id = hit?.id ?? null;

      if (id !== hoverRef.current.id) {
        hoverRef.current = { id, screenX: pt.x, screenY: pt.y };
        canvas.style.cursor = id ? "pointer" : "grab";

        const tip = tipRef.current;
        if (tip) {
          if (hit) {
            /**
             * 换一颗星时才重放动画。
             *
             * 直接在同一个元素上改文字,视觉上是"啪"地一下换掉 ——
             * 用户会觉得标签是突然冒出来的。这里改成:先把标签压暗下沉,
             * 下一帧再淡入浮起,于是"浮现"这两个字才有对应的动效。
             * 同一颗星之间移动指针不重放,否则标签会一直闪。
             */
            const changed = tip.dataset.nodeId !== hit.id;
            tip.dataset.nodeId = hit.id;
            tip.textContent = hit.label;

            if (changed) {
              tip.style.transition = "none";
              tip.style.opacity = "0";
              tip.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0) translateY(6px) scale(0.96)`;
              // 强制一次样式计算,让上面的初始态被浏览器"看见"
              void tip.offsetHeight;
              tip.style.transition = "opacity 200ms var(--ease-out), transform 200ms var(--ease-out)";
            }
            tip.style.opacity = "1";
            tip.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0) translateY(0) scale(1)`;
          } else {
            tip.dataset.nodeId = "";
            tip.style.transition = "opacity 140ms var(--ease-out)";
            tip.style.opacity = "0";
          }
        }
      } else if (id) {
        hoverRef.current.screenX = pt.x;
        hoverRef.current.screenY = pt.y;
        const tip = tipRef.current;
        if (tip) tip.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0) translateY(0) scale(1)`;
      }
    };

    const endDrag = (e: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag.active) return;
      drag.active = false;
      canvas.style.cursor = "grab";
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

      // 位移超过阈值算拖拽,不算点击 —— 否则每次平移都会误选一篇论文
      if (drag.moved > 6) return;

      const scene = liveRef.current.scene;
      const { w, h } = sizeRef.current;
      if (!scene || !w || !h) return;

      const world = screenToWorld(cameraRef.current, w, h, localPoint(e));
      const hit = hitTest(scene, world.x, world.y, cameraRef.current.scale);
      onSelect(hit?.id ?? null);

      /**
       * 侧栏开着时,单击直接聚焦这篇论文。
       *
       * 详情已经在手边,再点一次"聚焦"按钮是多余的一步;而侧栏收着时
       * 单击只选中(双击才打开侧栏 + 聚焦),不改原来的探索手感。
       */
      if (hit && focusOnSelectRef.current) {
        const scale = clampScale(Math.max(1.6, cameraRef.current.scale));
        const inset = Math.min(rightInsetRef.current, w * 0.45);
        targetRef.current = { x: hit.x + inset / 2 / scale, y: hit.y, scale };
      }
    };

    const onDoubleClick = (e: MouseEvent) => {
      const scene = liveRef.current.scene;
      const { w, h } = sizeRef.current;
      if (!scene || !w || !h) return;
      const pt = localPoint(e);
      const world = screenToWorld(cameraRef.current, w, h, pt);
      const hit = hitTest(scene, world.x, world.y, cameraRef.current.scale);
      if (!hit) return;
      onStarDoubleClickRef.current?.(hit.id);
      // 双击聚焦:推近到论文层级,并把星体移到屏幕中心
      targetRef.current = { x: hit.x, y: hit.y, scale: clampScale(Math.max(1.5, cameraRef.current.scale * 2.2)) };
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("dblclick", onDoubleClick);

    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("dblclick", onDoubleClick);
    };
  }, [localPoint, onSelect]);

  // ---------------------------------------------------------------------
  // 渲染循环
  // ---------------------------------------------------------------------
  const levelRef = useRef<ViewLevel>("paper");
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = performance.now();
    let elapsed = 0;

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;
      elapsed += dt;

      const { w, h } = sizeRef.current;
      if (w > 0 && h > 0) {
        const pending = pendingFitRef.current;
        if (pending) {
          pendingFitRef.current = null;
          const cam = fitIntoView(pending.bounds, w, h);
          cameraRef.current = cam;
          targetRef.current = cam;
        }

        // 相机平滑:只在没到位时收敛,到位后不做事(省电,也让渲染可被跳帧)
        const moving = !cameraClose(cameraRef.current, targetRef.current);
        if (moving) {
          cameraRef.current = reduceMotion
            ? targetRef.current
            : lerpCamera(cameraRef.current, targetRef.current, dt, 7);
        }

        const level = viewLevelOf(cameraRef.current.scale);
        if (level !== levelRef.current) {
          levelRef.current = level;
          onViewLevelChange?.(level);
        }

        // 指针平滑:每帧朝目标逼近一点,得到"跟手但不黏"的视差
        const pr = pointerRef.current;
        const k = Math.min(1, dt * 3);
        pr.x += (pr.tx - pr.x) * k;
        pr.y += (pr.ty - pr.y) * k;

        const sceneNow = liveRef.current.scene;
        if (sceneNow) {
          const dpr = sizeRef.current.dpr;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // 先把动画推进一帧,再绘制 —— 顺序反了会慢一帧,快速操作时看得出来
          const anim = animRef.current;
          if (reduceMotion) {
            // 尊重系统设置:直接落到终态,不做过渡
            for (const n of sceneNow.nodes) anim.nodeAlpha.set(n.id, n.dimmed ? 0.16 : 1);
            for (const e of sceneNow.edges) anim.edgeAlpha.set(e.id, e.faded ? 0.1 : 1);
            anim.focusId = selectedIdRef.current;
            anim.focus = selectedIdRef.current ? 1 : 0;
          } else {
            stepAnim(anim, sceneNow, dt, selectedIdRef.current);
          }

          drawScene(ctx, {
            scene: sceneNow,
            camera: cameraRef.current,
            width: w,
            height: h,
            theme: liveRef.current.theme,
            level,
            time: reduceMotion ? 0 : elapsed,
            pointer: reduceMotion ? { x: 0, y: 0 } : pointerRef.current,
            anim,
          });
        }

      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [onViewLevelChange, fitIntoView]);

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2,
          display: "block",
          width: "100%",
          height: "100%",
          cursor: payload ? "grab" : "default",
          touchAction: "none",
        }}
        aria-label="论文星图"
        role="img"
      />
      <div
        ref={tipRef}
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 z-40 max-w-[340px] truncate rounded-lg border border-hair-2 bg-surface/92 px-3 py-2 text-[11.5px] text-ink-2 opacity-0 shadow-[0_10px_30px_-14px_rgba(0,0,0,0.8)] backdrop-blur-md"
        style={{
          transform: "translate3d(-9999px,-9999px,0)",
          transformOrigin: "top left",
          transition: "opacity 200ms var(--ease-out), transform 200ms var(--ease-out)",
        }}
      />
    </>
  );
}
