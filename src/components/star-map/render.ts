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
import { domainTone, PALETTES, type CanvasPalette } from "@/lib/design/palette";
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
      return { nebula: 0.22, blob: 0.4, edge: 1, node: 1, paperLabel: 1, communityLabel: 0.5, domainLabel: 0.12 };
  }
}

const toneOf = (key: string, p: CanvasPalette): string =>
  (p as unknown as Record<string, string>)[key] ?? p.ink3;

export function drawScene(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { scene, camera, width, height, theme, level, time } = input;
  const p = PALETTES[theme];
  const a = levelAlpha(level);

  ctx.clearRect(0, 0, width, height);

  // ---------- 1. 星云底光 ----------
  if (a.nebula > 0.01) drawNebulae(ctx, scene, camera, width, height, theme, a.nebula, time);

  // ---------- 2. 星团底光(比星云更亮一档,缩近时浮现) ----------
  if (a.blob > 0.01 && a.blob < 1) {
    drawBlobs(ctx, scene.communities, camera, width, height, theme, a.blob * 0.5);
  } else if (a.blob >= 1) {
    drawBlobs(ctx, scene.communities, camera, width, height, theme, 0.42);
  }

  // ---------- 3. 边 ----------
  if (a.edge > 0.01) drawEdges(ctx, scene, camera, width, height, p, a.edge, level);

  // ---------- 4. 星体 ----------
  if (a.node > 0.01) drawNodes(ctx, scene, camera, width, height, p, a.node, time);

  // ---------- 5. 标签 ----------
  drawLabels(ctx, scene, camera, width, height, p, a, level);
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
    const c = worldToScreen(camera, width, height, { x: d.x, y: d.y });
    const r = d.r * camera.scale;
    if (r < 18) continue;
    if (c.x + r < 0 || c.x - r > width || c.y + r < 0 || c.y - r > height) continue;

    // 极缓慢的呼吸:幅度必须小到「几乎察觉不到,但画面是活的」
    const breathe = 1 + Math.sin(time * 0.22 + d.tone) * 0.012;
    const radius = r * breathe;

    const g = ctx.createRadialGradient(c.x, c.y, radius * 0.08, c.x, c.y, radius);
    const tone = domainTone(d.tone, theme);
    g.addColorStop(0, tone);
    g.addColorStop(0.55, tone.replace(/[\d.]+\)$/, "0.05)"));
    g.addColorStop(1, "transparent");

    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.fill();
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
  camera: Camera,
  width: number,
  height: number,
  p: CanvasPalette,
  alpha: number,
  level: ViewLevel,
): void {
  ctx.save();
  ctx.lineCap = "round";

  // 按 (色调, 是否高亮, 层级) 分桶:同一桶只设置一次 strokeStyle
  const buckets = new Map<
    string,
    {
      tone: string;
      active: boolean;
      layer: "structural" | "semantic";
      dash: number[] | null;
      segs: Array<[number, number, number, number]>;
    }
  >();

  const margin = 80;
  for (const e of scene.edges) {
    const na = scene.nodes[e.a];
    const nb = scene.nodes[e.b];
    if (!na || !nb) continue;

    const pa = worldToScreen(camera, width, height, na);
    const pb = worldToScreen(camera, width, height, nb);

    // 视口裁剪:两端都在屏幕外同一侧的边直接跳过
    if (
      (pa.x < -margin && pb.x < -margin) ||
      (pa.x > width + margin && pb.x > width + margin) ||
      (pa.y < -margin && pb.y < -margin) ||
      (pa.y > height + margin && pb.y > height + margin)
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
    bucket.segs.push([pa.x, pa.y, pb.x, pb.y]);
  }

  for (const bucket of buckets.values()) {
    ctx.strokeStyle = toneOf(bucket.tone, p);
    ctx.setLineDash(bucket.dash ?? []);

    /**
     * 两层线,两种角色。
     *
     * 引用边是**骨架**:它数量最多(动辄上千条),画清楚就够了,不能亮,
     * 否则整张图糊成一张灰网,注意力无处安放。
     * 语义边是**结论**:只有几条到几十条,是用户真正要读的东西,
     * 必须从骨架里浮出来。所以同一层级下它比引用边亮三倍左右。
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
          ? 0.13
          : 0.17;

    ctx.globalAlpha = base * alpha;
    ctx.lineWidth = bucket.active ? 1.2 : semantic ? 1 : 0.6;

    ctx.beginPath();
    for (const [x1, y1, x2, y2] of bucket.segs) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
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
  camera: Camera,
  width: number,
  height: number,
  p: CanvasPalette,
  alpha: number,
  time: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = p.blend;

  // 亮度 = 被引量的对数归一;分 5 桶,每桶一次 fill
  const maxLog = Math.log10(Math.max(10, ...scene.nodes.map((n) => n.citations)) + 1);
  const buckets: Array<{ nodes: Scene["nodes"]; alpha: number; radius: number }> = [];
  const BUCKETS = 5;
  for (let b = 0; b < BUCKETS; b++) {
    buckets.push({ nodes: [], alpha: 0.16 + (b / (BUCKETS - 1)) * 0.68, radius: 0.85 + (b / (BUCKETS - 1)) * 0.75 });
  }

  for (const n of scene.nodes) {
    const log = Math.log10(n.citations + 1);
    const t = Math.max(0, Math.min(1, log / Math.max(1, maxLog)));
    const b = Math.min(BUCKETS - 1, Math.floor(t * BUCKETS));
    buckets[b]?.nodes.push(n);
  }

  for (const bucket of buckets) {
    if (!bucket.nodes.length) continue;
    ctx.globalAlpha = alpha * bucket.alpha;
    ctx.fillStyle = p.ink;
    ctx.beginPath();
    for (const n of bucket.nodes) {
      if (n.dimmed) continue;
      const c = worldToScreen(camera, width, height, n);
      if (c.x < -20 || c.x > width + 20 || c.y < -20 || c.y > height + 20) continue;
      // 上限 9px:图很小时相机会推得很近,不封顶的话星体会涨成一个个圆盘,
      // 既不像"星",也会把连线端点盖住
      const r = Math.max(0.7, Math.min(9, n.r * camera.scale * bucket.radius));
      ctx.moveTo(c.x + r, c.y);
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  ctx.restore();
  ctx.save();

  // ---------- 种子、选中与悬浮:唯一的强调 ----------
  for (const n of scene.nodes) {
    if (!n.seed && !n.selected && !n.hovered) continue;
    const c = worldToScreen(camera, width, height, n);
    const r = Math.max(2.5, n.r * camera.scale);

    if (n.seed) {
      const pulse = 1 + Math.sin(time * 1.1) * 0.06;
      ctx.globalAlpha = 0.5 * alpha;
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, (r + 7) * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (n.hovered || n.selected) {
      ctx.globalAlpha = (n.selected ? 0.95 : 0.6) * alpha;
      ctx.strokeStyle = n.selected ? p.accent : p.ink2;
      ctx.lineWidth = n.selected ? 1.4 : 1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + 4.5, 0, Math.PI * 2);
      ctx.stroke();
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
      const c = worldToScreen(camera, width, height, n);
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
      ctx.globalAlpha = 0.9 * a.domainLabel;
      ctx.font = `500 15px ${SANS}`;
      ctx.fillStyle = p.ink;
      ctx.fillText(d.label, c.x, c.y);

      if (d.labelEn) {
        ctx.globalAlpha = 0.35 * a.domainLabel;
        ctx.font = `9px ${MONO}`;
        ctx.fillStyle = p.ink3;
        ctx.fillText(d.labelEn.toUpperCase(), c.x, c.y + 18);
      }

      ctx.globalAlpha = 0.28 * a.domainLabel;
      ctx.strokeStyle = p.ink3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.x - 26, c.y + 28);
      ctx.lineTo(c.x + 26, c.y + 28);
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
