/**
 * 星图渲染 —— 纯函数,只依赖入参,不碰 React、不碰 DOM 之外的东西。
 *
 * 为什么坚持纯函数:绘制逻辑几乎每轮迭代都要动,而它一旦和组件生命周期纠缠在一起,
 * 就没法脱离浏览器验证。保持纯净之后,同一份代码既能在页面里跑,
 * 也能在 Node 里渲染出用于文档的截图。
 *
 * 性能约定:
 *   - 星体按亮度分桶,每桶只做一次 fill —— 700 个节点从 700 次绘制降到 6 次
 *   - 边只画屏幕内的(视口裁剪),缩放后大部分边根本看不见
 *   - 文字只在层级需要时绘制,且每层都有数量上限
 */

import { worldToScreen, type Camera } from "@/lib/design/camera";
import { edgeCurve, edgeSeed, pointOnEdge } from "@/lib/design/edge-curve";
import { placeLabelBlock, wrapByWidth } from "@/lib/design/label-layout";
import { smoothstep } from "@/lib/design/motion";
import { nebulaOutline } from "@/lib/design/nebula";
import { domainToneBase, hexA, PALETTES, type CanvasPalette } from "@/lib/design/palette";
import { hashSeed } from "@/lib/graph/rng";
import type { Scene, SceneBlob, SceneEdge } from "@/lib/graph/scene";
import type { Theme } from "@/hooks/use-theme";
import type { ViewLevel } from "@/types/starfield";

/**
 * 逐帧动画状态。
 *
 * 为什么需要它:淡出、出现、选中入场都是**过程**,不是状态。
 * 直接把"当前是否筛掉"塞进颜色里,效果是一帧跳变 —— 用户看到的是
 * "闪了一下",而不是"淡出了"。这里给每个节点与每条边一个当前不透明度,
 * 每帧朝目标值逼近一点,于是所有的显示/隐藏/高亮都自然变成过渡。
 *
 * 状态放在渲染层而不是场景层:场景是数据的投影(纯函数、可复算),
 * 而"正在淡到多少"是纯粹的视觉过程,重建场景时不该被重置。
 */
export interface AnimState {
  nodeAlpha: Map<string, number>;
  edgeAlpha: Map<string, number>;
  /** 选中项的入场进度 0→1 */
  focus: number;
  focusId: string | null;
}

export function createAnimState(): AnimState {
  return { nodeAlpha: new Map(), edgeAlpha: new Map(), focus: 0, focusId: null };
}

/** 指数逼近:按秒收敛,与刷新率无关。 */
function approach(current: number, target: number, dt: number, speed: number): number {
  const k = 1 - Math.exp(-speed * dt);
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 0.004 ? target : next;
}

export function stepAnim(
  anim: AnimState,
  scene: Scene,
  dt: number,
  selectedId: string | null,
): void {
  for (const n of scene.nodes) {
    const target = n.dimmed && !n.hovered && !n.selected ? 0.16 : 1;
    // 首次出现的节点从透明开始:新增论文会真正"亮起来",而不是瞬现
    anim.nodeAlpha.set(n.id, approach(anim.nodeAlpha.get(n.id) ?? 0, target, dt, 4.2));
  }
  for (const e of scene.edges) {
    // 被关掉的边留 12% 而不是归零:让"这里曾经有线"仍然可辨,
    // 也让重新打开时有一个明确的起点
    const target = e.faded ? 0.12 : 1;
    // 新关系线也从 0 淡入;已有关系仍从当前值继续逼近目标
    anim.edgeAlpha.set(e.id, approach(anim.edgeAlpha.get(e.id) ?? 0, target, dt, 3.2));
  }

  /**
   * 入场与退场都要有动效。
   *
   * 关键在 focusId 的生命周期:取消选中时**不能**立刻把它清空 ——
   * 一旦清空,就没有任何节点再承载 focus 进度,退场动画等于没有。
   * 所以先让它继续衰减,衰减到底再释放。
   */
  if (selectedId) {
    if (selectedId !== anim.focusId) {
      anim.focusId = selectedId;
      anim.focus = 0;
    }
  } else if (anim.focus < 0.01) {
    anim.focusId = null;
  }
  anim.focus = approach(anim.focus, selectedId ? 1 : 0, dt, 5.5);
}

export interface RenderInput {
  scene: Scene;
  camera: Camera;
  width: number;
  height: number;
  theme: Theme;
  /** 当前层级;过渡期间由 levelAlpha 的交叉淡入表现,不需要单独传 from/to */
  level: ViewLevel;
  /** 用于呼吸与漂浮的时间(秒)。传 0 可得到完全静止的一帧,截图用。 */
  time: number;
  /** 归一化指针位置(-0.5~0.5),用于视差。让"近"的星跟着手移动,画面才有纵深。 */
  pointer?: { x: number; y: number };
  /** 逐帧动画状态;不传则一切都按终态绘制(截图、测试用) */
  anim?: AnimState;
  /** 关系卡双论文聚焦时的"第二篇":画一圈同伴环,表示它也在焦点里 */
  companionId?: string | null;
  /**
   * 缩略图取景。
   *
   * 超大星空的「装下全部」会把缩放压到 0.1 以下,按正常语义缩放
   * 星体会淡到 6%、关系线直接归零 —— 缩略图会变成一张空底图。
   * 这个模式只固定可读的绘制浓度,几何、节点、边与标签规则都不变。
   */
  preview?: boolean;
}

/**
 * 每个层级的可见度。
 *
 * 三层不是三套画面,而是同一张图的三种读法 —— 交叉淡入让「缩放」看起来像
 * 抽象层级在切换,而不是图片在放大。
 *
 * 有一点要特别注意:**文字不跟着层级开关**。层级是按缩放阈值离散跳的,
 * 如果把标题挂在层级上,越过阈值的那一帧标题就会"啪"地出现/消失。
 * 所以两类标题的可见度都直接由缩放算,并且是一段区间而不是一个点。
 */
function levelAlpha(scale: number) {
  /**
   * 论文标题:0.68 开始浮出、0.9 完全显示。
   * paper 阈值(0.78)正好落在区间中间 —— 跨过它时标题在半途,
   * 所以缩放看到的是"渐渐出现/退下去"。
   */
  const paperLabel = smoothstep(0.76, 1, scale);
  /**
   * 一级领域标题:拉远最亮,推近时一路退场,同样是一段区间。
   * 它挂在星云中心上,所以缩放时跟着云一起走,而不是被顶到云外面。
   */
  const domainLabel = 1 - smoothstep(0.5, 0.95, scale);

  /**
   * 星体与边:也按**缩放**连续变化,不再按层级取三档。
   *
   * 层级是按阈值离散跳的:越过 0.34 的那一刻,星体从 6% 直接跳到 62%,
   * 越过 0.78 又从 62% 跳到 100% —— 看上去是"整张图闪了一下"。
   * 现在分两段爬坡,阈值正好落在各自区间的半途:
   *   0.20 → 0.50  : 星体 0.06 → 0.62,边 0 → 0.55
   *   0.64 → 0.92  : 星体 0.62 → 1,边 0.55 → 1
   * 缩放时星星是"渐渐亮起来"的,边的明暗与它同进同退。
   */
  const near = smoothstep(0.2, 0.5, scale);
  const close = smoothstep(0.64, 0.92, scale);

  return {
    // 星云:拉远时最实,推近后让位给星体
    nebula: 1 - 0.38 * near - 0.4 * close,
    // 星团:中间层最亮,两端都收
    blob: 0.12 + 0.88 * near - 0.6 * close,
    edge: 0.55 * near + 0.45 * close,
    node: 0.06 + 0.56 * near + 0.38 * close,
    paperLabel,
    domainLabel,
  };
}

const toneOf = (key: string, p: CanvasPalette): string =>
  (p as unknown as Record<string, string>)[key] ?? p.ink3;

/** 视差强度(屏幕像素)。数值小是刻意的:星图是数据,不能跟着鼠标乱晃。 */
const PARALLAX = 12;

export function drawScene(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { scene, camera, width, height, theme, level, time } = input;
  const pointer = input.pointer ?? { x: 0, y: 0 };
  const anim = input.anim ?? createAnimState();
  const p = PALETTES[theme];
  const a = input.preview
    ? { nebula: 0, blob: 0, edge: 0.35, node: 1, paperLabel: 0, domainLabel: 0 }
    : levelAlpha(camera.scale);

  ctx.clearRect(0, 0, width, height);

  /**
   * 先算一次"漂浮之后"的屏幕坐标,星体和连线共用这一份。
   *
   * 这是全场最容易被写错的地方:如果星体加了漂浮而连线仍然连静止坐标,
   * 线就会慢慢从星上滑开,越飘越明显。共用一份坐标是唯一稳的做法。
   */
  const fx = new Float64Array(scene.nodes.length);
  const fy = new Float64Array(scene.nodes.length);
  for (let i = 0; i < scene.nodes.length; i++) {
    const n = scene.nodes[i];
    if (!n) continue;
    const m = n.motion;
    const c = worldToScreen(camera, width, height, {
      x: n.x + Math.cos(time * m.spd + m.phx) * m.amp,
      y: n.y + Math.sin(time * m.spd * 1.13 + m.phy) * m.amp,
    });
    // 越"近"的星跟着指针动得越多 → 平面图有了纵深
    fx[i] = c.x - pointer.x * PARALLAX * m.dp;
    fy[i] = c.y - pointer.y * PARALLAX * m.dp;
  }

  // ---------- 1. 星云底光 ----------
  if (a.nebula > 0.01) drawNebulae(ctx, scene, camera, width, height, theme, a.nebula, time);

  // ---------- 2. 星团底光(比星云更亮一档,缩近时浮现) ----------
  /**
   * 统一成"峰值 × 可见度"。
   *
   * 之前分成两段:可见度 <1 时乘 0.5,≥1 时固定 0.42 ——
   * 可见度刚过 1 的那一帧反而变暗(0.5 → 0.42),是另一处缩放跳变。
   */
  if (a.blob > 0.01) drawBlobs(ctx, scene.communities, camera, width, height, theme, 0.42 * a.blob);

  // ---------- 3. 边 ----------
  if (a.edge > 0.01) drawEdges(ctx, scene, width, height, p, a.edge, level, fx, fy, time * 14, anim);

  // ---------- 4. 星体 ----------
  if (a.node > 0.01) {
    drawNodes(
      ctx,
      scene,
      width,
      height,
      p,
      a.node,
      time,
      fx,
      fy,
      camera.scale,
      anim,
      input.companionId ?? null,
    );
  }

  // ---------- 5a. 引用方向的粒子 ----------
  /**
   * 粒子常驻,所以放在"选中相关"的绘制之外 —— 它是主干信息,
   * 不是选中之后的详情。领域层除外:那个尺度上论文都还在,
   * 粒子会变成一片没意义的噪点。
   */
  if (a.edge > 0.01 && level !== "domain") {
    drawCitationParticles(ctx, scene, p, fx, fy, anim, time, level, a.edge);
  }

  // ---------- 5b. 语义关系的文字 ----------
  if (a.edge > 0.01) {
    drawEdgeLabels(ctx, scene, fx, fy, camera.scale, width, height, p, anim, level);
  }

  // ---------- 5. 标签 ----------
  drawLabels(ctx, scene, camera, width, height, p, a, fx, fy, anim);
}

// ---------------------------------------------------------------------------
// 星云
// ---------------------------------------------------------------------------

function drawNebulae(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
  theme: Theme,
  alpha: number,
  time: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";

  for (const d of scene.domains) {
    // 极缓慢的呼吸:幅度小到"几乎察觉不到,但画面是活的"
    const breathe = 1 + Math.sin(time * 0.2 + d.tone) * 0.014;

    const parts = d.blobs?.length ? d.blobs : [{ x: d.x, y: d.y, r: d.r }];

    ctx.globalAlpha = 1;
    parts.forEach((blob, i) => {
      const c = worldToScreen(camera, width, height, { x: blob.x, y: blob.y });
      const r = blob.r * camera.scale * breathe;
      if (r < 12) return;
      if (c.x + r < 0 || c.x - r > width || c.y + r < 0 || c.y - r > height) return;

      paintSoftBlob(
        ctx,
        c.x,
        c.y,
        r * 0.86,
        hashSeed(`${d.id}:${i}`) / 4294967296,
        (a) => hexA(domainToneBase(d.tone, theme), a),
        0.1 * alpha,
      );
    });
  }

  ctx.restore();
}

function drawBlobs(
  ctx: CanvasRenderingContext2D,
  blobs: SceneBlob[],
  camera: Camera,
  width: number,
  height: number,
  theme: Theme,
  alpha: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = theme === "dark" ? "lighter" : "source-over";
  blobs.forEach((b, i) => {
    const c = worldToScreen(camera, width, height, { x: b.x, y: b.y });
    const r = b.r * camera.scale;
    if (r < 14) return;
    if (c.x + r < 0 || c.x - r > width || c.y + r < 0 || c.y - r > height) return;

    ctx.globalAlpha = 1;
    paintSoftBlob(
      ctx,
      c.x,
      c.y,
      r * 0.86,
      hashSeed(`${b.id}:${i}`) / 4294967296,
      (a) => hexA(domainToneBase(b.tone, theme), a),
      0.24 * alpha,
    );
  });
  ctx.restore();
}

/**
 * 一团"云",而不是一个"光晕"。
 *
 * 一段径向渐变画出来的圆,边界永远是完美的圆弧 —— 叠得再多也只是几个圆。
 * 这里的做法是同一套**带起伏的轮廓**叠四层:外圈很淡、内圈更亮,
 * 每一层用同一粒种子,所以几层是同心的异形而不是互相打结。
 * 结果是:边缘是毛的、内部是软的,像云,不像灯泡。
 *
 * 轮廓点由 lib/design/nebula.ts 生成(纯几何、可测);
 * 这里只负责把点连成平滑闭合曲线再填色。
 */
function paintSoftBlob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  seed: number,
  colorAt: (alpha: number) => string,
  strength: number,
): void {
  /**
   * 外淡内亮八层,比例与透明度一起收。
   *
   * 层数不是为了好看,而是为了**没有台阶**:四层时两层之间的半径差太大,
   * 叠在深色背景上能看出一圈圈轮廓(像等高线);八层之后每层只差 7% 半径,
   * 叠出来的核心约等于 strength * 1.24,过渡是连续的。
   */
  const layers = [
    { scale: 1, weight: 0.06 },
    { scale: 0.93, weight: 0.08 },
    { scale: 0.86, weight: 0.1 },
    { scale: 0.79, weight: 0.12 },
    { scale: 0.72, weight: 0.14 },
    { scale: 0.65, weight: 0.16 },
    { scale: 0.58, weight: 0.18 },
    { scale: 0.5, weight: 0.2 },
  ] as const;

  for (const layer of layers) {
    const pts = nebulaOutline(cx, cy, r * layer.scale, seed);
    const n = pts.length;
    const last = pts[n - 1];
    const first = pts[0];
    if (!last || !first) continue;

    // 闭合的平滑曲线:每段用相邻两点的中点作起止,点本身作控制点
    ctx.beginPath();
    ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
    for (let i = 0; i < n; i++) {
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      if (!cur || !next) continue;
      ctx.quadraticCurveTo(cur.x, cur.y, (cur.x + next.x) / 2, (cur.y + next.y) / 2);
    }
    ctx.closePath();
    ctx.fillStyle = colorAt(strength * layer.weight);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// 边
// ---------------------------------------------------------------------------

function drawEdges(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  width: number,
  height: number,
  p: CanvasPalette,
  alpha: number,
  level: ViewLevel,
  fx: Float64Array,
  fy: Float64Array,
  flow: number,
  anim: AnimState,
): void {
  ctx.save();
  ctx.lineCap = "round";

  const buckets = new Map<
    string,
    {
      tone: string;
      active: boolean;
      layer: "structural" | "semantic";
      faded: boolean;
      dash: number[] | null;
      segs: number[];
      minAlpha: number;
    }
  >();

  const margin = 80;
  for (const e of scene.edges) {
    const ax = fx[e.a];
    const ay = fy[e.a];
    const bx = fx[e.b];
    const by = fy[e.b];
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;

    // 视口裁剪:两端都在屏幕外同一侧的边直接跳过
    if (
      (ax < -margin && bx < -margin) ||
      (ax > width + margin && bx > width + margin) ||
      (ay < -margin && by < -margin) ||
      (ay > height + margin && by > height + margin)
    ) {
      continue;
    }

    // 形状只有一份来源(与粒子轨迹、关系标签共用),见 lib/design/edge-curve.ts
    const { cx, cy } = edgeCurve(ax, ay, bx, by, e.id);

    const layer = e.layer === "semantic" ? "semantic" : "structural";
    // 高亮同样挂在 focusId 上:取消选中后焦点边的亮度是"收回"而不是"跳回"
    const focused =
      anim.focusId !== null &&
      (scene.nodes[e.a]?.id === anim.focusId || scene.nodes[e.b]?.id === anim.focusId);
    const key = `${e.tone}|${focused ? 1 : 0}|${layer}|${e.faded ? 1 : 0}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        tone: e.tone,
        active: focused,
        layer,
        faded: e.faded,
        dash: e.dash,
        segs: [],
        minAlpha: 1,
      };
      buckets.set(key, bucket);
    }
    bucket.segs.push(ax, ay, cx, cy, bx, by);
    // 同桶取最暗的一条:整桶一起淡,不会有一帧内的亮度不一致
    bucket.minAlpha = Math.min(bucket.minAlpha, anim.edgeAlpha.get(e.id) ?? 1);
  }

  for (const bucket of buckets.values()) {
    ctx.strokeStyle = toneOf(bucket.tone, p);
    ctx.setLineDash(bucket.dash ?? []);

    /**
     * 两层线,两种角色。
     *
     * 引用边是**骨架**:数量最多(动辄上千条),画清楚就够了,不能亮 ——
     * 否则整张图糊成一张灰网,注意力无处安放。
     * 语义边是**结论**:只有几条到几十条,是用户真正要读的东西,
     * 必须从骨架里浮出来。
     */
    const semantic = bucket.layer === "semantic";
    // 在"静"与"亮"两档之间按 focus 插值,高亮与退场都是连续的
    const idle = semantic ? (level === "paper" ? 0.46 : 0.4) : level === "paper" ? 0.14 : 0.18;
    const lit = semantic ? 0.78 : 0.45;
    const base = bucket.active ? idle + (lit - idle) * Math.max(0, Math.min(1, anim.focus)) : idle;

    /*
      边不按条动画(那要几千个浮点数),而是同桶共用一个当前透明度:
      淡入淡出时整桶一起变化,足够顺滑。
      被关掉的关系淡到几乎只剩痕迹 —— 要能看出"这里原来有线",但不该再抢注意力。
    */
    // 淡出已经包含在 bucket.minAlpha 里,不再叠一个瞬时系数
    ctx.globalAlpha = base * alpha * bucket.minAlpha;
    ctx.lineWidth = bucket.active ? 1.2 : semantic ? 1 : 0.6;

    // 语义边让虚线缓缓流动:线是"活的",静态的虚线看起来只是样式
    if (semantic) {
      ctx.lineDashOffset = -flow;
    }

    ctx.beginPath();
    for (let i = 0; i < bucket.segs.length; i += 6) {
      ctx.moveTo(bucket.segs[i] ?? 0, bucket.segs[i + 1] ?? 0);
      ctx.quadraticCurveTo(
        bucket.segs[i + 2] ?? 0,
        bucket.segs[i + 3] ?? 0,
        bucket.segs[i + 4] ?? 0,
        bucket.segs[i + 5] ?? 0,
      );
    }
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 星体
// ---------------------------------------------------------------------------

function drawNodes(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  width: number,
  height: number,
  p: CanvasPalette,
  alpha: number,
  time: number,
  fx: Float64Array,
  fy: Float64Array,
  scale: number,
  anim: AnimState,
  companionId: string | null,
): void {
  ctx.save();
  ctx.globalCompositeOperation = p.blend;

  const maxLog = Math.log10(Math.max(10, ...scene.nodes.map((n) => n.citations)) + 1);
  const themeNow: Theme = p === PALETTES.light ? "light" : "dark";

  /**
   * 一颗一颗画,而不是按亮度分桶批量画。
   *
   * 分桶是为了省绘制次数,但它要求"同一桶里的星透明度一致" ——
   * 而淡入淡出恰恰让每颗星的透明度都不同。既然动画的优先级更高,
   * 就放弃这点批量化:几十到几百个圆弧,对一帧来说微不足道。
   */
  for (let i = 0; i < scene.nodes.length; i++) {
    const n = scene.nodes[i];
    const x = fx[i];
    const y = fy[i];
    if (!n || x === undefined || y === undefined) continue;

    // focus 挂在 focusId 上而不是 selected:退场时那颗星已经不 selected 了,
    // 但动画还要在它身上播完
    const focus = n.id === anim.focusId ? anim.focus : 0;
    const nodeAlpha = anim.nodeAlpha.get(n.id) ?? 1;
    const a = alpha * nodeAlpha;
    if (a < 0.01) continue;

    if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue;

    const twinkle = 0.86 + 0.14 * Math.sin(time * 1.25 * n.motion.tws + n.motion.tw);
    const brightness = Math.max(0, Math.min(1, Math.log10(n.citations + 1) / Math.max(1, maxLog)));
    const base = Math.max(1.8, Math.min(9, n.r * scale));
    // 选中:幅度刻意压小 —— 反馈要看得见,但不该把整张图的注意力抢走
    const r = base * (1 + focus * 0.22) * (n.hovered ? 1.25 : 1) * (0.96 + 0.08 * twinkle);

    /**
     * 光晕大小也跟着引用量走。
     *
     * 高被引的论文在学术上就是"更亮的星",给它更大的光晕是在用视觉
     * 复述一个真实事实;所有星用同样的光晕倍数,等于把这层信息丢掉。
     */
    const glow = (ga: number) => hexA(domainToneBase(n.tone, themeNow), ga);
    const haloScale = (3 + brightness * 3.4) * (1 + focus * 0.12);
    const haloR = r * (n.hovered ? haloScale * 1.25 : haloScale);
    const g = ctx.createRadialGradient(x, y, 0, x, y, haloR);
    g.addColorStop(0, glow((n.hovered || focus > 0.01 ? 0.26 : 0.17) * twinkle * (1 + focus * 0.25)));
    g.addColorStop(0.45, glow(0.06 * twinkle));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();

    // 星核
    ctx.globalAlpha = a * (0.42 + brightness * 0.58) * (0.94 + 0.06 * twinkle);
    ctx.fillStyle = p.ink;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // 环:三种身份各一层,互相叠加而不是互相覆盖
    if (n.seed) {
      const pulse = 1 + Math.sin(time * 1.1) * 0.06;
      ctx.globalAlpha = 0.5 * a;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, (r + 7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (n.hovered && focus < 0.01) {
      ctx.globalAlpha = 0.55 * a;
      ctx.strokeStyle = p.ink2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (focus > 0.01) {
      // 环只向外走一点点:6px 的行程,退场时沿同一条路径收回
      const ease = 1 - (1 - focus) * (1 - focus);
      ctx.globalAlpha = a * focus * 0.6;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(x, y, r + 4 + ease * 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    /**
     * 关系卡的"另一篇":一圈低透明度的同伴环。
     *
     * 不用选中态(那颗星不该展开完整标题),但要让用户一眼看出
     * "这条关系说的是这两篇"——镜头同时框住它们,环也同时亮着。
     */
    if (companionId && n.id === companionId && focus < 0.01) {
      ctx.globalAlpha = 0.34 * a;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 边上的关系类型
// ---------------------------------------------------------------------------

/** 同时最多标几条边。多了会糊成一片注释,反而没人读。 */
const EDGE_LABEL_LIMIT = 10;

/** 关系标签落在边上的位置:0.34 = 靠近选中星那一端的三分之一处 */
const EDGE_LABEL_T = 0.34;

/**
 * 压在选中标题上时,沿自己的边让开的档位(相对于 EDGE_LABEL_T)。
 *
 * 顺序是"先小后大、正负交替":先试原位,再就近挪 —— 挪得越少,标签越像是
 * 本来就长在那里。**不会因为让不开就不画**:关系是信息,少一条就是少读一条;
 * 让不开时退回事先算好的原位,宁可叠一点,也不凭空消失。
 */
const EDGE_LABEL_SHIFT = [0.08, -0.08, 0.16, -0.16, 0.26, -0.26, 0.36, -0.36] as const;

/** 屏幕上的一个矩形:关系标签用它与选中标题避让。 */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxesHit(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** 以 (x,y) 为中心的一段文字,是否压住了那块地。 */
function labelsClash(
  at: { x: number; y: number },
  halfW: number,
  halfH: number,
  area: Box,
): boolean {
  return boxesHit(
    { x0: at.x - halfW, y0: at.y - halfH, x1: at.x + halfW, y1: at.y + halfH },
    area,
  );
}

/**
 * 选中星与它的完整标题占的那块地:关系标签不许进去。
 *
 * 抢位置时永远是注解输 —— 标题回答"这颗星是什么",注解回答"它和谁有关",
 * 前者读不到,后者就没有意义。
 *
 * 这个框**照实算**:形状交给 drawLabels 用的同一套排版函数,不是拍一个
 * 大概的范围。框太大,标签会被赶到很远的边上(于是"关系"读起来离星很远);
 * 框太小,两段文字又会叠在一起。
 */
function focusArea(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  fx: Float64Array,
  fy: Float64Array,
  scale: number,
  width: number,
  height: number,
  index: number,
): Box | null {
  const n = scene.nodes[index];
  const x = fx[index];
  const y = fy[index];
  if (!n || x === undefined || y === undefined) return null;

  const r = Math.max(2.5, n.r * scale);
  let box: Box = { x0: x - r - 10, y0: y - r - 10, x1: x + r + 10, y1: y + r + 10 };

  ctx.font = `${FOCUS_TITLE.px}px ${SANS}`;
  const lines = wrapCached(ctx, n.label, FOCUS_TITLE.maxW, FOCUS_TITLE.maxLines);
  if (!lines.length) return box;

  const lineH = FOCUS_TITLE.px * FOCUS_TITLE.lineH;
  const block = placeLabelBlock({
    lines,
    lineHeight: lineH,
    anchor: { x, y: y + r + 13 },
    viewport: { width, height },
    padding: FOCUS_TITLE.pad,
    measure: (s) => ctx.measureText(s).width,
  });
  const first = block.positions[0];
  const last = block.positions[block.positions.length - 1];
  if (!first || !last) return box;

  const pad = 6;
  box = {
    x0: Math.min(box.x0, first.x - block.width / 2 - pad),
    y0: box.y0,
    x1: Math.max(box.x1, first.x + block.width / 2 + pad),
    y1: Math.max(box.y1, last.y + lineH / 2 + pad),
  };
  return box;
}

/**
 * 把关系类型写在边旁边。
 *
 * 有了它,"这条线是什么意思"就不需要去对照右下角的图例 ——
 * 读图的地方和图例离得越远,读图的成本越高。
 *
 * 只标**与当前选中项相连**的语义边:全局标注等于给整张图加了一层噪声;
 * 用户点了一颗星之后,他关心的恰好就是这一些。
 */
function drawEdgeLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  fx: Float64Array,
  fy: Float64Array,
  scale: number,
  width: number,
  height: number,
  p: CanvasPalette,
  anim: AnimState,
  level: ViewLevel,
): void {
  if (!anim.focusId) return;
  if (anim.focus < 0.12) return;

  /**
   * 从"当前选中了谁"出发找边 —— 只有一个真相源,不依赖场景里预先算好的标志。
   */
  const focusIndex = scene.nodes.findIndex((n) => n.id === anim.focusId);
  if (focusIndex < 0) return;

  /**
   * 只标语义边。
   *
   * 引用边一度也标了"引用"两个字,但那样每条线都要配一个词,
   * 而引用**本身是一种有方向的流动**,用文字说"引用"等于把一个
   * 一秒钟就能看到的事实写成句子。改用沿边流动的粒子指示方向 ——
   * 粒子从"引用的那一方"流向"被引用的那一方",不用读文字就知道谁引了谁。
   *
   * 语义边没有方向可言(或者方向不是重点),继续用文字说明。
   */
  const shown = scene.edges
    .filter(
      (e) =>
        e.label.length > 0 && !e.faded && (e.a === focusIndex || e.b === focusIndex),
    )
    .sort((x, y) => {
      // 语义边优先,其次按置信度 —— 一排标签里,重要的一定在最前
      const rank = (e: typeof x) => (e.layer === "semantic" ? 1e6 : 0) + e.confidence;
      return rank(y) - rank(x);
    })
    .slice(0, EDGE_LABEL_LIMIT);
  if (!shown.length) return;

  const appear = Math.min(1, Math.max(0, (anim.focus - 0.12) / 0.62));
  const ease = 1 - (1 - appear) * (1 - appear);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const halfH = 9;
  const gapX = 7;

  /**
   * 选中星与它的标题占的那块地。
   *
   * 关系标签宁可让一让,也不该压在这句话上 —— 标题回答"这颗星是什么",
   * 注解回答"它和谁有关";两段字叠在一起时,两句话都读不成。
   */
  const guard = focusArea(ctx, scene, fx, fy, scale, width, height, focusIndex);

  ctx.font = `10.5px ${SANS}`;

  for (const e of shown) {
    /**
     * 标签**落在自己那条边上**,并跟着它一起走。
     *
     * 两个"跟着":取漂浮后的屏幕坐标(与画线、粒子同一份),并且取的是
     * 弧线上参数 t 处的点(与画线、粒子同一个函数)。
     *
     * 之前这里取的是**静止坐标 + 直线中点**:边画成弧线、两端还会漂,
     * 于是标签悬在离自己那条线十几像素的地方 —— 越放大越明显,
     * 读起来像一句不属于任何一条线的注释。注解必须长在它注解的东西上。
     */
    const ax = fx[e.a];
    const ay = fy[e.a];
    const bx = fx[e.b];
    const by = fy[e.b];
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;
    const curve = edgeCurve(ax, ay, bx, by, e.id);

    /**
     * 标签落在**靠近选中星的那一端**,而不是边的中点。
     *
     * 中点会让所有标签散落在整张图上,眼睛要跟着每一条线走一遍才能找到它;
     * 靠选中星这一端时,标签自然聚成一个扇形,读起来是"从这颗星出发的
     * 若干种关系",而不是一堆散落的注释。
     */
    const fromA = e.a === focusIndex;
    // 位置固定:只在出现时淡入,不滑动。之前那 0.06 的位移在长边上
    // 会被放大成相当明显的一段滑动
    const base = fromA ? EDGE_LABEL_T : 1 - EDGE_LABEL_T;
    const halfW = ctx.measureText(e.label).width / 2 + gapX;

    // 原位;压住标题就沿自己的边往外让,让不开就回到原位(不丢注解)
    let at = pointOnEdge(curve, base);
    if (guard && labelsClash(at, halfW, halfH, guard)) {
      for (const shift of EDGE_LABEL_SHIFT) {
        const cand = pointOnEdge(curve, Math.max(0.08, Math.min(0.92, base + shift)));
        // 别让到另一端的星身上去
        if (Math.hypot(cand.x - bx, cand.y - by) < 26) continue;
        if (labelsClash(cand, halfW, halfH, guard)) continue;
        at = cand;
        break;
      }
    }
    const mx = at.x;
    const my = at.y;
    if (mx < 46 || mx > width - 46 || my < 30 || my > height - 30) continue;

    /**
     * 没有底衬:文字直接浮在边上。
     * 也不描边:描边会在文字外面多出一圈"白边/黑边",放大后尤其明显,
     * 看起来像贴纸。密集处靠颜色与透明度区分就够了。
     */
    ctx.globalAlpha = ease * (level === "paper" ? 0.95 : 0.6);
    ctx.fillStyle = toneOf(e.tone, p);
    ctx.fillText(e.label, mx, my);
  }

  ctx.restore();
}

/**
 * 引用方向粒子。
 *
 * 沿边流动的小点,方向 = 引用方向(引用者 → 被引用者)。
 *
 * 为什么这样比文字好:引用是有向的,而"有向"是一个**过程** ——
 * 用静态文字标注去向,读的人要在脑子里再翻译一次;粒子直接把过程演出来。
 * 这是整套视觉里唯一一处"动起来的信息",因此只在选中星体时出现,不常驻。
 */
/**
 * 一条边的**当前亮度**(0~1 量级的 alpha)。画线与粒子共用这一个函数。
 *
 * 这是这一版最关键的修正:之前"线有多亮"和"粒子该不该有光晕"是两套
 * 各自演化的公式 —— 它们在边缘情况上不断漂移,表现就是
 * "有的亮边有光晕、有的没有",而且每次改一处都只修好一半。
 *
 * 现在只有一个真相源:这个数大,线就亮、粒子就有光晕;这个数小,
 * 线就暗、粒子就暗且无光晕。两者不可能再对不上。
 */
function edgeLuminance(
  e: SceneEdge,
  level: ViewLevel,
  anim: AnimState,
  focusIndex: number,
): number {
  const semantic = e.layer === "semantic";
  const idle = semantic ? (level === "paper" ? 0.46 : 0.4) : level === "paper" ? 0.14 : 0.18;
  const lit = semantic ? 0.78 : 0.45;
  const focused = focusIndex >= 0 && (e.a === focusIndex || e.b === focusIndex);
  const f = Math.max(0, Math.min(1, anim.focus));
  const base = focused ? idle + (lit - idle) * f : idle;
  /**
   * "被关掉"这件事**只通过逐帧透明度表达**,不在这里再乘一个瞬时系数。
   *
   * 之前 0.12 被乘了三次:这里一次、画线时一次、动画目标里一次 ——
   * 其中两个是瞬时的,于是开关一按,边和粒子直接跳到几乎不可见,
   * 那个渐变的那个根本来不及起作用,看起来就是"没有动效"。
   */
  return base * (anim.edgeAlpha.get(e.id) ?? 1);
}

function drawCitationParticles(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  p: CanvasPalette,
  fx: Float64Array,
  fy: Float64Array,
  anim: AnimState,
  time: number,
  level: ViewLevel,
  /** 边在缩放档位上的可见度:粒子必须跟着边一起淡入淡出 */
  edgeAlpha: number,
): void {
  /**
   * 粒子常驻,不再等选中才出现。
   *
   * 引用方向是这个图谱里唯一客观可核验的关系,它本身就值得一直看得见 ——
   * 之前把它藏在"点击之后"是把它当成了详情,而它其实是主干信息。
   */
  const focusIndex = anim.focusId ? scene.nodes.findIndex((n) => n.id === anim.focusId) : -1;

  /**
   * 粒子和线**同进同退** —— 线被关掉,粒子也跟着关掉。
   *
   * 但要按 `hasCitation` 而不是 `kind` 来筛:语义边(基线、同期……)
   * 背后往往就是一条引用(基线关系本来就建立在引用之上),合并之后
   * kind 变成语义类型,引用那条被"吃掉"了 —— 用 kind 筛会把它们全漏掉。
   * 那些边是亮着的,所以它们的引用方向理应看得见。
   */
  /**
   * 不按 faded 排除,交给透明度去淡。
   *
   * 之前直接把被关掉的边滤掉,于是开关引用时粒子是**瞬间**消失的 ——
   * 而线是渐渐淡下去的,两者对不上。现在一律画出来,
   * 亮度跟着边自己的淡出进度走,开关就变成了同一段过渡。
   */
  const links = scene.edges.filter((e) => e.hasCitation);
  if (!links.length) return;

  ctx.save();
  ctx.globalCompositeOperation = p.blend;

  for (const e of links) {
    /**
     * 亮度与光晕都取自 edgeLuminance —— 与画线用的是同一个数。
     * 0 = 暗到不该有光晕,1 = 完全点亮。
     */
    const lum = edgeLuminance(e, level, anim, focusIndex);
    const glow = Math.max(0, Math.min(1, (lum - 0.18) / 0.3));

    // 粒子跟着线走,所以取的是漂浮后的屏幕坐标
    const ax = fx[e.a];
    const ay = fy[e.a];
    const bx = fx[e.b];
    const by = fy[e.b];
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;

    // 与画线、关系标签共用同一条曲线,粒子才会正好落在线上
    const curve = edgeCurve(ax, ay, bx, by, e.id);
    const seed = edgeSeed(e.id);

    // 方向只由**引用**决定;语义边自己的方向与它无关
    const citeFrom = e.citationFrom ?? e.from;
    // 贝塞尔是按 a→b 参数化的,引用方向若是 b→a 就把参数反过来
    const forward = citeFrom === e.a;
    /**
     * 速度按**世界坐标**下的边长算,不按屏幕像素。
     *
     * 原来用屏幕长度,于是缩放一变、每条边的"长度"跟着变,
     * 粒子的快慢也就跟着变 —— 同一颗星在放大缩小时像换了个节奏。
     * 世界长度只跟图的形状有关,与相机无关,缩放时节奏才是稳定的。
     */
    const na = scene.nodes[e.a];
    const nb = scene.nodes[e.b];
    const worldLen = na && nb ? Math.hypot(na.x - nb.x, na.y - nb.y) : 200;
    // 整体放缓:方向是提示,不是动画片
    const speed = 0.2 / Math.max(0.4, Math.min(2.2, worldLen / 220));
    const phase = seed;


    // 一条边同时只有一个粒子:方向是"点"的信息,不需要一串
    {
      const raw = (time * speed + phase) % 1;
      const u = forward ? raw : 1 - raw;
      const { x: px, y: py } = pointOnEdge(curve, u);

      // 两端渐隐:粒子从引用者身上"生成",到被引用者身上"汇入"
      /**
       * 端部过渡收窄到 9%(原来 14%)。
       *
       * 它决定了粒子"从边上长出来 / 汇进去"的那一小段 —— 但
       * 只有一个粒子时,这段过渡会在每一圈里占掉近三成的时间,
       * 于是任意时刻总有一部分粒子正好隐在端部,看起来就是
       * "有的有光晕、有的没有"。
       */
      const posFade = Math.min(1, Math.min(u, 1 - u) / 0.09);
      const strength = Math.min(1, posFade * (0.3 + 0.7 * glow));
      if (strength < 0.02) continue;

      const r = (1.4 + 0.5 * posFade) * (0.82 + 0.45 * glow);

      /**
       * 光晕**不跟着位置一起消失**。
       *
       * 之前光晕的透明度直接乘 strength,于是粒子走到边两端时
       * 光晕也一起没了 —— 而"有没有光晕"本该只由边的明暗决定。
       * 现在光晕只受位置轻微影响(最低保留 60%),端部只收一点点,
       * 于是整条边上光晕始终在,只是端点处稍弱。
       */
      if (glow > 0.02) {
        // 位置只轻微影响光晕(最低保留 60%):有没有光晕由边的明暗决定,
        // 不该由粒子此刻跑到哪儿决定
        const glowA = (0.6 + 0.4 * posFade) * glow * edgeAlpha;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4.4);
        g.addColorStop(0, hexA(p.accent, Math.min(1, 1.35 * glowA)));
        g.addColorStop(0.45, hexA(p.accent, Math.min(1, 0.4 * glowA)));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r * 4.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = Math.min(1, (0.62 + 0.33 * glow) * strength) * edgeAlpha;
      ctx.fillStyle = glow > 0.5 ? p.ink : p.ink2;
      ctx.beginPath();
      ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

const LABEL_LIMIT = { paper: 26, domain: 10 } as const;

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
  p: CanvasPalette,
  a: ReturnType<typeof levelAlpha>,
  fx: Float64Array,
  fy: Float64Array,
  anim: AnimState,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ---------- 论文标签:推近时渐渐浮出(可见度由缩放连续给出),且只标最重要的那些 ----------
  if (a.paperLabel > 0.02) {
    const important = scene.nodes
      /**
       * 焦点节点无条件进入候选。
       *
       * 之前它会被三个条件筛掉:被筛暗淡、被引量为 0、或离视口边缘太近 ——
       * 于是"点了一颗星,标题却没出现"。选中是用户主动做的动作,
       * 它的反馈不该被这些针对**背景标签**的限额决定。
       */
      .filter((n) => n.id === anim.focusId || (!n.dimmed && n.citations > 0))
      .sort((x, y) => {
        // 种子与焦点项永远优先,其余按被引量。
        // 这里用 focusId 而不是 selected:退场过程中那颗星已经不是 selected 了,
        // 但它的标签还得留在名单里把动画播完。
        const rank = (n: typeof x) =>
          (n.seed ? 1e9 : 0) +
          (n.id === anim.focusId || n.hovered ? 5e8 : 0) +
          n.citations;
        return rank(y) - rank(x);
      })
      .slice(0, LABEL_LIMIT.paper);

    for (const n of important) {
      const i = scene.nodes.indexOf(n);
      const x = fx[i];
      const y = fy[i];
      if (x === undefined || y === undefined) continue;
      const c = { x, y };
      const isFocus = n.id === anim.focusId;
      // 焦点节点放宽边距:它就该在边上也能看全
      const margin = isFocus ? 8 : 60;
      if (c.x < margin || c.x > width - margin || c.y < 40 || c.y > height - 40) continue;

      const focus = n.id === anim.focusId ? anim.focus : 0;

      /**
       * "重点态"的浓度:0 = 普通标签,1 = 重点标签。
       *
       * 这里原来是布尔量 `n.seed || n.hovered || focus > 0.01` —— 而 focus
       * 一旦超过 0.01 它就从 false 翻成 true,于是字号(10.5→12)与
       * 透明度(0.55→0.95)**瞬间**跳到重点态,动画再从那个大号字开始演。
       * 用户看到的就是"先冒出一个较大的标题,再开始动效"。
       *
       * 改成连续量之后,焦点从 0 涨到 1 的过程中,字号与透明度同步过渡,
       * 起点正好是常规状态,终点才是重点态。
       */
      const keyLevel = n.seed ? 1 : n.hovered ? 1 : 1 - (1 - focus) * (1 - focus);

      /**
       * 文字本身是不可插值的:截断长度一变,渲染出来的字符串就整个换掉,
       * 那一帧必然是跳的 —— 字号可以连续过渡,字符串不行。
       *
       * 所以这一项用**交叉淡入**:短版与长版同时画,透明度互补。
       * 两版的公共前缀完全一致,叠在一起看起来就是文字从末尾"长出来",
       * 而不是换了一段字。
       */
      /**
       * 字号与透明度都由 keyLevel 连续插值:
       *   keyLevel = 0 → 10.5px / 0.40  (常规标签,与选中无关时一模一样)
       *   keyLevel = 1 → 12.0px / 0.95  (重点态)
       * 再乘一个由焦点驱动的缩放(1 → 1.16),那是"选中"本身的动作。
       *
       * 颜色统一用 p.ink,靠透明度表达明暗 —— 之前按阈值在 ink2/ink 之间
       * 切换,那个切换本身也是一次跳变。
       */
      const r = Math.max(2.5, n.r * camera.scale);
      const scaleIn = 1 + 0.16 * (1 - (1 - focus) * (1 - focus));
      const fontPx = (10.5 + 1.5 * keyLevel) * scaleIn;

      ctx.font = `${fontPx.toFixed(1)}px ${SANS}`;
      ctx.fillStyle = p.ink;

      const shortText = truncate(n.label, 30);
      /**
       * 重点态的一行版:种子论文常驻在图上,一占三行就把邻居压住了,
       * 所以它保持一行、只把截断放宽;真正展开成完整标题是在**选中**之后。
       */
      const keyText = truncate(n.label, 52);
      const alphaBase = (0.4 + 0.55 * keyLevel) * a.paperLabel;
      // 标签压在星体上会互相干扰,统一挪到星体下方
      const labelY = c.y + r + 13;

      /**
       * 两段文字的出手顺序:旧的先退,新的后进。
       *
       * 文字不是图形 —— 两串字叠在一起时,眼睛看到的是**重影**,不是"溶解"。
       * 所以这里刻意让它们错开:旧版在 keyLevel 到 0.5 之前退干净,
       * 新版从 0.1 才开始进。中间那一小段两边都淡是刻意的 ——
       * 它把"换了内容"读成一次交接,而不是两层字压在一起。
       */
      const exit = 1 - smoothstep(0, 0.5, keyLevel);
      const enter = smoothstep(0.1, 0.58, keyLevel);

      // 常态:一行,截断到 30 字。重点态或选中时退场
      if (exit > 0.01) {
        ctx.globalAlpha = alphaBase * exit;
        ctx.fillText(shortText, c.x, labelY);
      }

      /**
       * 长版:选中时展开的**完整标题**,必要时折行 —— 不再用越来越长的截断。
       *
       * 一行五六十个字符会横跨半屏,把邻居和边全压住;折成两三行之后
       * 它仍然贴在星体正下方,读起来还属于这颗星。
       *
       * 排版(字号、栏宽、断行点、行数)全部由常量决定,与选中进度无关 ——
       * 于是第一帧到最后一帧是同一份排布,动效只改透明度。
       * 之前折行是拿**当帧字号**去量的,而字号在动画里连续长大,
       * 断行点就跟着每帧重算,看起来像文字在一个框里不停重排。
       *
       * 也不画底衬:多行文字压在星空上仍然读得清,而一块矩形底衬会把它
       * 变成"浮动卡片",跟四周无底衬的标签不是一套语言。
       */
      if (enter > 0.01) {
        if (isFocus) {
          drawFocusTitle(ctx, n.label, c.x, labelY, width, height, alphaBase, keyLevel, p.ink);
        } else {
          ctx.globalAlpha = alphaBase * enter;
          ctx.fillText(keyText, c.x, labelY);
        }
      }
    }
  }

  /**
   * ---------- 一级领域标题 ----------
   *
   * 只保留领域这一级标题:二级(社区/子领域)标题挂在星团上,
   * 缩到中间层时会和星团本身抢注意力,而它回答的问题("这是哪个大方向")
   * 已经由一级标题回答了。
   *
   * 位置锚在**星云中心**:缩放时它跟着云一起走、始终在云的正中 ——
   * 之前是"抬到云顶再按视口高度夹一下",于是越缩越偏,最后和云脱节。
   */
  if (a.domainLabel > 0.02) {
    const labels = scene.domains.length
      ? [...scene.domains].sort((x, y) => y.count - x.count).slice(0, LABEL_LIMIT.domain)
      : [];

    for (const d of labels) {
      const c = worldToScreen(camera, width, height, { x: d.x, y: d.y });
      // 允许一部分出屏(云心本来就可能贴着边),完全出去才跳过
      if (c.x < -160 || c.x > width + 160 || c.y < -60 || c.y > height + 60) continue;

      const cy = c.y;
      ctx.globalAlpha = 0.9 * a.domainLabel;
      ctx.font = `500 15px ${SANS}`;
      ctx.fillStyle = p.ink;
      ctx.fillText(d.label, c.x, cy);

      if (d.labelEn) {
        ctx.globalAlpha = 0.35 * a.domainLabel;
        ctx.font = `9px ${MONO}`;
        ctx.fillStyle = p.ink3;
        ctx.fillText(d.labelEn.toUpperCase(), c.x, cy + 18);
      }
    }
  }

  ctx.restore();
}

const SANS =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, Menlo, monospace';

/**
 * 选中标题的排版常量。
 *
 * 它们**必须是常量**:只要字号或栏宽跟着动画走,断行点就会在动画里重算,
 * 用户看到的就是"文字随着框的大小在重排"。
 */
const FOCUS_TITLE = {
  /**
   * 字号:与「重点态」标签(普通 10.5px → 重点 13.9px)同一档偏小,
   * 但不随选中进度长大 —— 它一出现就是最终大小。
   */
  px: 13,
  /** 栏宽:超过就在这里断行 */
  maxW: 300,
  /** 最多几行:再多就压住邻居了,末行收一个省略号 */
  maxLines: 3,
  /** 行距倍数 */
  lineH: 1.42,
  /** 与视口边缘的最小留白 */
  pad: 14,
} as const;

/**
 * 选中星体下方的完整标题。
 *
 * 位置规则:
 *   - 首行落在短版标签原来那一行上,所以交叉淡入看起来是"从这一行往下长出来";
 *   - 星体贴着视口边缘时,把整块文字平移进来(位移只跟星体位置有关,
 *     与动画进度无关,因此不会在动画中途跳一下)。
 *
 * 出场规则:一行一行地落,不是整块一起浮出来 —— 第一行先出现在原位,
 * 后面的行依次跟上。三行同时淡入会读成"一块新的东西盖上来",
 * 依次淡入才读成"这句话展开了"。每行的曲线都从 `reveal` 派生,
 * 与第二行、第三行是否已经出现无关。
 */
function drawFocusTitle(
  ctx: CanvasRenderingContext2D,
  label: string,
  anchorX: number,
  anchorY: number,
  viewW: number,
  viewH: number,
  alpha: number,
  reveal: number,
  color: string,
): void {
  ctx.font = `${FOCUS_TITLE.px}px ${SANS}`;
  const lines = wrapCached(ctx, label, FOCUS_TITLE.maxW, FOCUS_TITLE.maxLines);
  if (!lines.length) return;

  const block = placeLabelBlock({
    lines,
    lineHeight: FOCUS_TITLE.px * FOCUS_TITLE.lineH,
    anchor: { x: anchorX, y: anchorY },
    viewport: { width: viewW, height: viewH },
    padding: FOCUS_TITLE.pad,
    measure: (s) => ctx.measureText(s).width,
  });

  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  lines.forEach((line, i) => {
    const at = block.positions[i];
    if (!at) return;
    const shown = smoothstep(0.1 + 0.12 * i, 0.58 + 0.12 * i, reveal);
    if (shown <= 0.01) return;
    ctx.globalAlpha = alpha * shown;
    ctx.fillText(line, at.x, at.y);
  });
}

/**
 * 折行结果缓存。
 *
 * 折行算法在 lib/design/label-layout.ts(纯函数、可脱离浏览器验证),
 * 这里只补一层缓存:同一颗星选中期间,折行的输入(文字、字号、栏宽)是恒定的,
 * 每帧重新量一遍纯属浪费。缓存之外,它还让"断行一定稳定"这件事更硬 ——
 * 同一个 key 只会拿到同一份行数组。
 */
const wrapCache = new Map<string, string[]>();

function wrapCached(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const key = `${ctx.font}|${maxWidth}|${maxLines}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const lines = wrapByWidth(text, maxWidth, maxLines, (s) => ctx.measureText(s).width);
  if (wrapCache.size > 256) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
