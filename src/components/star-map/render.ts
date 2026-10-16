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
import { domainTone, domainToneBase, hexA, PALETTES, type CanvasPalette } from "@/lib/design/palette";
import type { Scene, SceneBlob } from "@/lib/graph/scene";
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
    anim.nodeAlpha.set(n.id, approach(anim.nodeAlpha.get(n.id) ?? 1, target, dt, 7));
  }
  for (const e of scene.edges) {
    const target = e.faded ? 0.1 : 1;
    anim.edgeAlpha.set(e.id, approach(anim.edgeAlpha.get(e.id) ?? 1, target, dt, 7));
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
}

/**
 * 每个层级的可见度。
 *
 * 三层不是三套画面,而是同一张图的三种读法 —— 交叉淡入让「缩放」看起来像
 * 抽象层级在切换,而不是图片在放大。
 */
function levelAlpha(level: ViewLevel) {
  switch (level) {
    case "domain":
      return { nebula: 1, blob: 0.12, edge: 0, node: 0.06, paperLabel: 0, communityLabel: 0, domainLabel: 1 };
    case "community":
      return { nebula: 0.62, blob: 1, edge: 0.55, node: 0.62, paperLabel: 0.12, communityLabel: 1, domainLabel: 0.35 };
    default:
      return { nebula: 0.22, blob: 0.4, edge: 1, node: 1, paperLabel: 1, communityLabel: 0.5, domainLabel: 0.05 };
  }
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
  const a = levelAlpha(level);

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
  if (a.blob > 0.01 && a.blob < 1) {
    drawBlobs(ctx, scene.communities, camera, width, height, theme, a.blob * 0.5);
  } else if (a.blob >= 1) {
    drawBlobs(ctx, scene.communities, camera, width, height, theme, 0.42);
  }

  // ---------- 3. 边 ----------
  if (a.edge > 0.01) drawEdges(ctx, scene, width, height, p, a.edge, level, fx, fy, time * 14, anim);

  // ---------- 4. 星体 ----------
  if (a.node > 0.01) {
    drawNodes(ctx, scene, width, height, p, a.node, time, fx, fy, camera.scale, anim);
  }

  // ---------- 5a. 引用方向的粒子 ----------
  /**
   * 粒子常驻,所以放在"选中相关"的绘制之外 —— 它是主干信息,
   * 不是选中之后的详情。领域层除外:那个尺度上论文都还在,
   * 粒子会变成一片没意义的噪点。
   */
  if (a.edge > 0.01 && level !== "domain") {
    drawCitationParticles(ctx, scene, p, fx, fy, anim, time);
  }

  // ---------- 5b. 语义关系的文字 ----------
  if (a.edge > 0.01) drawEdgeLabels(ctx, scene, camera, width, height, p, anim, level);

  // ---------- 5. 标签 ----------
  drawLabels(ctx, scene, camera, width, height, p, a, level, fx, fy, anim);
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
    const tone = domainTone(d.tone, theme);
    const core = tone.replace(/[\d.]+\)$/, "0.13)");
    const rim = tone.replace(/[\d.]+\)$/, "0.05)");

    const parts = d.blobs?.length ? d.blobs : [{ x: d.x, y: d.y, r: d.r }];

    ctx.globalAlpha = alpha;
    for (const blob of parts) {
      const c = worldToScreen(camera, width, height, { x: blob.x, y: blob.y });
      const r = blob.r * camera.scale * breathe;
      if (r < 12) continue;
      if (c.x + r < 0 || c.x - r > width || c.y + r < 0 || c.y - r > height) continue;

      const g = ctx.createRadialGradient(c.x, c.y, r * 0.05, c.x, c.y, r);
      g.addColorStop(0, core);
      g.addColorStop(0.62, rim);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
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
  for (const b of blobs) {
    const c = worldToScreen(camera, width, height, { x: b.x, y: b.y });
    const r = b.r * camera.scale;
    if (r < 14) continue;
    if (c.x + r < 0 || c.x - r > width || c.y + r < 0 || c.y - r > height) continue;

    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    const tone = domainTone(b.tone, theme);
    g.addColorStop(0, tone);
    g.addColorStop(0.6, tone.replace(/[\d.]+\)$/, "0.04)"));
    g.addColorStop(1, "transparent");

    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 边
// ---------------------------------------------------------------------------

/** 由边 id 派生一个稳定的 0-1 数:同一条边每帧形状一致。 */
function hashEdge(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

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

    /**
     * 边画成**弧线**而不是直线。
     *
     * 直线在密集处会让整张图变成一张渔网 —— 几十条线共用一个方向时,
     * 眼睛会把它们读成一块灰度背景,而不是"谁连着谁"。
     * 给每条边一个垂直于自身的偏移(长度越短弧越明显),线束自然散开,
     * 走向也能读出来了。偏移量由边的 id 决定,所以同一条边每一帧形状一致,
     * 不会随缩放抖成另一条线。
     */
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const seed = hashEdge(e.id);
    // 下限 7px:短边若按比例算几乎就是直线,而"线都是弯的"是这一版的整体语言
    const bow = Math.max(7, Math.min(30, len * 0.17)) * (seed < 0.5 ? -1 : 1) * (0.6 + seed * 0.8);
    const cx = (ax + bx) / 2 + (-dy / Math.max(1, len)) * bow;
    const cy = (ay + by) / 2 + (dx / Math.max(1, len)) * bow;

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
    ctx.globalAlpha = base * alpha * (bucket.faded ? 0.12 : 1) * bucket.minAlpha;
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
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 边上的关系类型
// ---------------------------------------------------------------------------

/** 同时最多标几条边。多了会糊成一片注释,反而没人读。 */
const EDGE_LABEL_LIMIT = 10;

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
  camera: Camera,
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
  ctx.font = `10.5px ${SANS}`;

  for (const e of shown) {
    /**
     * 标签锚在**静止坐标**上,不跟着星体漂浮。
     *
     * 之前直接用了漂浮后的屏幕坐标,于是每颗星一漂,挂在它边上的文字
     * 就跟着来回晃 —— 两端一起漂时,标签的位移差不多是星体振幅的一大半。
     * 星体漂浮是氛围,文字是注解;注解该稳,氛围该动。
     * 代价是标签不再精确压在浮动的线上,偏移最多几个像素,看不出。
     */
    const na = scene.nodes[e.a];
    const nb = scene.nodes[e.b];
    if (!na || !nb) continue;
    const pa = worldToScreen(camera, width, height, na);
    const pb = worldToScreen(camera, width, height, nb);
    const ax = pa.x;
    const ay = pa.y;
    const bx = pb.x;
    const by = pb.y;

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
    const t = 0.34;
    const mx = ax + (bx - ax) * (fromA ? t : 1 - t);
    const my = ay + (by - ay) * (fromA ? t : 1 - t);
    if (mx < 46 || mx > width - 46 || my < 30 || my > height - 30) continue;

    /**
     * 没有底衬:文字直接浮在边上。
     * 底衬虽然好读,但它把每条边都变成一个"胶囊",亲密感全丢了 ——
     * 现在靠加粗一点点字重和轻微的暗色描边保证在密集处的可读性。
     */
    ctx.globalAlpha = ease * (level === "paper" ? 0.95 : 0.6);
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = hexA(p.bg, 0.72);
    ctx.strokeText(e.label, mx, my);
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
function drawCitationParticles(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  p: CanvasPalette,
  fx: Float64Array,
  fy: Float64Array,
  anim: AnimState,
  time: number,
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
     * 选中项相连的边,粒子更强一档。
     *
     * 选中是"我在看这颗星"的声明,与它相关的引用方向理应更醒目 ——
     * 但只是"更醒目",不是"换一套视觉",所以仍是同一套参数乘以一个系数。
     */
    const focused = focusIndex >= 0 && (e.a === focusIndex || e.b === focusIndex);

    /**
     * 粒子的亮度与光晕,跟着**这条边当前的明暗**走 —— 而不是跟着它的类型走。
     *
     * 这里踩过一个坑:一度按 `e.layer === "semantic"` 判断要不要光晕。
     * 但"亮"与"是语义边"不是一回事:引用边在没被选中时是暗的,
     * 一旦与选中的星相连,它会被提亮到接近语义边的程度 ——
     * 那时它明明亮着,却因为 layer 是 structural 而没有光晕。
     *
     * 现在按亮度算:亮度 = 该类型在"静"与"亮"两档之间按焦点插值,
     * 与 drawEdges 里用的是同一个公式。于是光晕强度天然跟着焦点动画走,
     * 点击时渐显、取消时渐隐,不需要额外写一套过渡。
     */
    const idleLum = e.layer === "semantic" ? 0.46 : 0.14;
    const litLum = e.layer === "semantic" ? 0.78 : 0.45;
    const lum = focused ? idleLum + (litLum - idleLum) * anim.focus : idleLum;
    // 0 = 暗到不该有光晕;1 = 完全点亮
    const glow = Math.max(0, Math.min(1, (lum - 0.18) / 0.35));

    const boost = focused ? 1.4 : 1;
    const weight = 0.34 + 0.66 * glow;
    const ax = fx[e.a];
    const ay = fy[e.a];
    const bx = fx[e.b];
    const by = fy[e.b];
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) continue;

    // 与 drawEdges 用同一套弧线参数,粒子才会正好落在线上
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const seed = hashEdge(e.id);
    const bow = Math.max(7, Math.min(30, len * 0.17)) * (seed < 0.5 ? -1 : 1) * (0.6 + seed * 0.8);
    const cx = (ax + bx) / 2 + (-dy / Math.max(1, len)) * bow;
    const cy = (ay + by) / 2 + (dx / Math.max(1, len)) * bow;

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

    // 与线共用透明度:线在淡入淡出时,粒子跟着一起
    const edgeFade = anim.edgeAlpha.get(e.id) ?? 1;
    if (edgeFade < 0.05) continue;

    // 一条边同时只有一个粒子:方向是"点"的信息,不需要一串
    {
      const raw = (time * speed + phase) % 1;
      const u = forward ? raw : 1 - raw;
      const iu = 1 - u;
      const px = iu * iu * ax + 2 * iu * u * cx + u * u * bx;
      const py = iu * iu * ay + 2 * iu * u * cy + u * u * by;

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
      const strength = Math.min(1, posFade * edgeFade * boost * weight);
      if (strength < 0.02) continue;

      const r = (1.4 + 0.5 * posFade) * (0.85 + 0.3 * boost) * (0.84 + 0.3 * glow);

      /**
       * 光晕**不跟着位置一起消失**。
       *
       * 之前光晕的透明度直接乘 strength,于是粒子走到边两端时
       * 光晕也一起没了 —— 而"有没有光晕"本该只由边的明暗决定。
       * 现在光晕只受位置轻微影响(最低保留 60%),端部只收一点点,
       * 于是整条边上光晕始终在,只是端点处稍弱。
       */
      if (glow > 0.02) {
        const glowA = Math.min(1, (0.6 + 0.4 * posFade) * edgeFade * boost * weight * glow);
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 4.2);
        g.addColorStop(0, hexA(p.accent, Math.min(1, 1.15 * glowA)));
        g.addColorStop(0.45, hexA(p.accent, Math.min(1, 0.32 * glowA)));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r * 4.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = Math.min(1, (0.62 + 0.33 * glow) * strength);
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

const LABEL_LIMIT = { paper: 26, community: 14, domain: 10 } as const;

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  width: number,
  height: number,
  p: CanvasPalette,
  a: ReturnType<typeof levelAlpha>,
  level: ViewLevel,
  fx: Float64Array,
  fy: Float64Array,
  anim: AnimState,
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ---------- 论文标签:只在推近时出现,且只标最重要的那些 ----------
  if (a.paperLabel > 0.02 && level === "paper") {
    const important = scene.nodes
      .filter((n) => !n.dimmed && n.citations > 0)
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
      if (c.x < 60 || c.x > width - 60 || c.y < 40 || c.y > height - 40) continue;

      const focus = n.id === anim.focusId ? anim.focus : 0;
      const isKey = n.seed || n.hovered || focus > 0.01;
      const text = truncate(n.label, isKey ? 52 : 30);
      const r = Math.max(2.5, n.r * camera.scale);
      /**
       * 选中 = 在**常态之上的增量**,不是从零开始的另一套状态。
       *
       * 上一版把透明度乘了 focus,于是取消选中时它会一路淡到 0,
       * 等 focus 归零、焦点释放之后又跳回常态亮度 —— 用户看到的就是
       * "先完全消失,再冒出一个完整标题"。字号同理:终点定在 0.82 而
       * 常态是 1,收尾那一帧也会跳一下。
       *
       * 现在的两个量都以 1 为基准做加法:f=0 时完全等于常态,
       * f=1 时才是放大后的样子。整条曲线单调、连续,两端都不跳。
       */
      const ease = 1 - (1 - focus) * (1 - focus);
      const scaleIn = 1 + 0.16 * ease;
      const base = isKey ? 12 : 10.5;

      ctx.font = `${(base * scaleIn).toFixed(1)}px ${SANS}`;
      ctx.globalAlpha = (isKey ? 0.95 : 0.55) * a.paperLabel * (1 + 0.35 * ease);
      ctx.fillStyle = focus > 0.01 ? p.ink : p.ink2;

      // 标签压在星体上会互相干扰,统一挪到星体下方
      ctx.fillText(text, c.x, c.y + r + 13);
    }
  }

  // ---------- 社区标签 ----------
  if (a.communityLabel > 0.02) {
    const sorted = [...scene.communities].sort((x, y) => y.count - x.count).slice(0, LABEL_LIMIT.community);
    for (const b of sorted) {
      const c = worldToScreen(camera, width, height, { x: b.x, y: b.y });
      const r = b.r * camera.scale;
      if (r < 26) continue;
      if (c.x < 30 || c.x > width - 30 || c.y < 24 || c.y > height - 24) continue;

      ctx.globalAlpha = 0.85 * a.communityLabel;
      ctx.font = `11.5px ${SANS}`;
      ctx.fillStyle = p.ink2;
      ctx.fillText(b.label, c.x, c.y - r * 0.55);

      ctx.globalAlpha = 0.4 * a.communityLabel;
      ctx.font = `9px ${MONO}`;
      ctx.fillStyle = p.ink4;
      ctx.fillText(`${b.count} 篇 · ${b.medianYear}`, c.x, c.y - r * 0.55 + 15);
    }
  }

  // ---------- 领域标题:整张图最大的字,只有拉远时才出现 ----------
  if (a.domainLabel > 0.02) {
    const labels = scene.domains.length
      ? [...scene.domains].sort((x, y) => y.count - x.count).slice(0, LABEL_LIMIT.domain)
      : [];

    for (const d of labels) {
      const c = worldToScreen(camera, width, height, { x: d.x, y: d.y });
      if (c.x < 40 || c.x > width - 40 || c.y < 30 || c.y > height - 30) continue;

      // 拉近时星云标题该退场,而不是被论文标签淹掉
      // 标题落在云顶而不是云心:云心一定是星体最密的地方,标题压上去就糊了
      const cy = c.y - Math.min(d.r * camera.scale * 0.72, height * 0.3);
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

      ctx.globalAlpha = 0.28 * a.domainLabel;
      ctx.strokeStyle = p.ink3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.x - 26, cy + 28);
      ctx.lineTo(c.x + 26, cy + 28);
      ctx.stroke();
    }
  }

  ctx.restore();
}

const SANS =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, Menlo, monospace';

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
