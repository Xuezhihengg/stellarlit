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
  if (a.edge > 0.01) drawEdges(ctx, scene, width, height, p, a.edge, level, fx, fy);

  // ---------- 4. 星体 ----------
  if (a.node > 0.01) drawNodes(ctx, scene, width, height, p, a.node, time, fx, fy, camera.scale);

  // ---------- 5. 标签 ----------
  drawLabels(ctx, scene, camera, width, height, p, a, level, fx, fy);
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
): void {
  ctx.save();
  ctx.lineCap = "round";

  const buckets = new Map<
    string,
    {
      tone: string;
      active: boolean;
      layer: "structural" | "semantic";
      dash: number[] | null;
      segs: number[];
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

    const layer = e.layer === "semantic" ? "semantic" : "structural";
    const key = `${e.tone}|${e.active ? 1 : 0}|${layer}|${e.dash ? e.dash.join(",") : "solid"}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tone: e.tone, active: e.active, layer, dash: e.dash, segs: [] };
      buckets.set(key, bucket);
    }
    bucket.segs.push(ax, ay, bx, by);
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
    const base = bucket.active
      ? semantic
        ? 0.78
        : 0.45
      : semantic
        ? level === "paper"
          ? 0.46
          : 0.4
        : level === "paper"
          ? 0.14
          : 0.18;

    ctx.globalAlpha = base * alpha;
    ctx.lineWidth = bucket.active ? 1.2 : semantic ? 1 : 0.6;

    ctx.beginPath();
    for (let i = 0; i < bucket.segs.length; i += 4) {
      ctx.moveTo(bucket.segs[i] ?? 0, bucket.segs[i + 1] ?? 0);
      ctx.lineTo(bucket.segs[i + 2] ?? 0, bucket.segs[i + 3] ?? 0);
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
): void {
  ctx.save();
  ctx.globalCompositeOperation = p.blend;

  const themeNow: Theme = p === PALETTES.light ? "light" : "dark";
  const maxLog = Math.log10(Math.max(10, ...scene.nodes.map((n) => n.citations)) + 1);

  /**
   * 星体分两遍画:先铺光晕,再落星核。
   *
   * **光晕是这套视觉的灵魂**。没有它,星图就是一堆白点加线;
   * 有了它,每颗星才像"在发光",而光的颜色又编码了它所属的前沿 ——
   * 于是"哪些星是一伙的"不用看标签也能读出来。
   * 分两遍是因为加色混合下,先画的星核会被后画的邻星光晕提亮,
   * 顺序不定,亮度也就不稳定。
   */
  for (const n of scene.nodes) {
    if (n.dimmed) continue;
    const i = scene.nodes.indexOf(n);
    const x = fx[i];
    const y = fy[i];
    if (x === undefined || y === undefined) continue;
    if (x < -30 || x > width + 30 || y < -30 || y > height + 30) continue;

    const twinkle = 0.86 + 0.14 * Math.sin(time * 1.25 * n.motion.tws + n.motion.tw);
    const r = Math.max(0.7, Math.min(9, n.r * scale)) * (n.hovered ? 1.5 : 1);

    const haloR = r * (n.hovered || n.selected ? 9 : 5.5);
    // 光晕用所属前沿的色调:于是"哪些星是一伙的"不用看标签也能读出来
    const glow = (a: number) => hexA(domainToneBase(n.tone, themeNow), a);
    const g = ctx.createRadialGradient(x, y, 0, x, y, haloR);
    g.addColorStop(0, glow((n.hovered ? 0.36 : 0.22) * twinkle));
    g.addColorStop(0.45, glow(0.07 * twinkle));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = p.blend;
  const buckets: Array<{ idx: number[]; a: number; rr: number }> = [];
  const BUCKETS = 5;
  for (let b = 0; b < BUCKETS; b++) {
    buckets.push({ idx: [], a: 0.2 + (b / (BUCKETS - 1)) * 0.68, rr: 0.85 + (b / (BUCKETS - 1)) * 0.7 });
  }
  scene.nodes.forEach((n, i) => {
    if (n.dimmed) return;
    const t = Math.max(0, Math.min(1, Math.log10(n.citations + 1) / Math.max(1, maxLog)));
    buckets[Math.min(BUCKETS - 1, Math.floor(t * BUCKETS))]?.idx.push(i);
  });

  for (const bucket of buckets) {
    if (!bucket.idx.length) continue;
    ctx.globalAlpha = alpha * bucket.a;
    ctx.fillStyle = p.ink;
    ctx.beginPath();
    for (const i of bucket.idx) {
      const n = scene.nodes[i];
      const x = fx[i];
      const y = fy[i];
      if (!n || x === undefined || y === undefined) continue;
      const r = Math.max(0.7, Math.min(9, n.r * scale * bucket.rr));
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  ctx.restore();
  ctx.save();

  // ---------- 种子、选中与悬浮:唯一的强调 ----------
  scene.nodes.forEach((n, i) => {
    if (!n.seed && !n.selected && !n.hovered) return;
    const x = fx[i];
    const y = fy[i];
    if (x === undefined || y === undefined) return;
    const r = Math.max(2.5, Math.min(9, n.r * scale));

    if (n.seed) {
      const pulse = 1 + Math.sin(time * 1.1) * 0.06;
      ctx.globalAlpha = 0.5 * alpha;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, (r + 7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (n.hovered || n.selected) {
      ctx.globalAlpha = (n.selected ? 0.95 : 0.6) * alpha;
      ctx.strokeStyle = n.selected ? p.accent : p.ink2;
      ctx.lineWidth = n.selected ? 1.4 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r + 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

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
): void {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ---------- 论文标签:只在推近时出现,且只标最重要的那些 ----------
  if (a.paperLabel > 0.02 && level === "paper") {
    const important = scene.nodes
      .filter((n) => !n.dimmed && n.citations > 0)
      .sort((x, y) => {
        // 种子与选中项永远优先,其余按被引量
        const rank = (n: typeof x) => (n.seed ? 1e9 : 0) + (n.selected || n.hovered ? 5e8 : 0) + n.citations;
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

      const isKey = n.seed || n.selected || n.hovered;
      const text = truncate(n.label, isKey ? 46 : 30);
      const r = Math.max(2.5, n.r * camera.scale);

      ctx.font = `${isKey ? 12 : 10.5}px ${SANS}`;
      ctx.globalAlpha = (isKey ? 0.95 : 0.55) * a.paperLabel;
      ctx.fillStyle = p.ink2;

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
