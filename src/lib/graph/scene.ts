/**
 * 场景构建 —— 把图谱 + 布局翻译成「画什么」。
 *
 * 这一层刻意与绘制分开:场景是纯数据(测试友好、可在 Node 里生成截图),
 * 绘制只认场景、不认图谱。这样换渲染方式不需要动图算法,
 * 而调布局也不需要动渲染代码。
 */

import type { Graph, GraphEdge, GraphLayout, NodeId, Vec2 } from "@/types/kg";
import type { ViewLevel } from "@/types/starfield";

export interface SceneNode {
  id: NodeId;
  kind: "paper";
  x: number;
  y: number;
  /** 世界坐标下的视觉半径 */
  r: number;
  label: string;
  tone: number;
  year: number;
  citations: number;
  /** 是否是用户输入的种子 */
  seed: boolean;
  selected: boolean;
  hovered: boolean;
  /** 被时间轴筛掉:画成暗星 */
  dimmed: boolean;
  /** 该节点相关的关系类型集合,决定高光色 */
  relationKinds: string[];
}

export interface SceneEdge {
  id: string;
  kind: GraphEdge["kind"];
  layer: GraphEdge["layer"];
  /** 指向 Scene.nodes 的下标 */
  a: number;
  b: number;
  directed: boolean;
  weight: number;
  confidence: number;
  tone: EdgeToneKey;
  dash: number[] | null;
  /** 两端至少有一端是高亮节点 */
  active: boolean;
}

export interface SceneBlob {
  id: NodeId;
  kind: "community" | "domain";
  label: string;
  labelEn?: string;
  x: number;
  y: number;
  r: number;
  tone: number;
  count: number;
  medianYear: number;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  communities: SceneBlob[];
  domains: SceneBlob[];
  /** 世界包围盒,用于相机自适应 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SceneOptions {
  selectedId?: NodeId | null;
  hoveredId?: NodeId | null;
  /** 用户关闭了哪些关系类型 */
  hiddenKinds?: ReadonlySet<string>;
  /** 只保留这个年份之后的工作;null 表示不限 */
  minYear?: number | null;
}

/**
 * 边的色调以**调色板键名**存储,而不是 CSS 变量字符串。
 *
 * Canvas 读不到 CSS 变量:`ctx.strokeStyle = "var(--accent)"` 不会报错,
 * 它会静默地保持上一次的颜色 —— 这类错误在深色主题下几乎看不出来,
 * 在白底上才会暴露。存键名由渲染层解析,顺带让「一色一义」这条规则
 * 只在一个地方被定义。
 */
export type EdgeToneKey = "ink4" | "ink3" | "ink2" | "accent" | "warm" | "alert";

const EDGE_TONE: Record<string, EdgeToneKey> = {
  // 引用线用 ink3 而不是 ink4:ink4 在深空底色上几乎不可见,
  // 而引用关系是整张图的骨架,看不见骨架的星图就只剩一堆散点
  CITES: "ink3",
  BASELINE_OF: "ink2",
  EXTENDS: "accent",
  SIMILAR_APPROACH: "accent",
  ALTERNATIVE_TO: "warm",
  CONTEMPORARY_OF: "ink3",
  CONTRADICTS: "alert",
  POTENTIAL_LINK: "warm",
};

const EDGE_DASH: Record<string, number[] | null> = {
  CONTEMPORARY_OF: [2, 7],
  POTENTIAL_LINK: [3, 5],
};

const isSemantic = (kind: string): boolean =>
  kind !== "CITES" && kind !== "MENTIONS" && kind !== "AUTHORED_BY" && kind !== "PUBLISHED_IN";

/**
 * 论文的视觉半径。
 *
 * 半径跟**年份**相关而不是跟被引量相关:被引量已经用亮度表达了,
 * 两个通道表达同一个变量是浪费。年份映射到大小之后,
 * 「越新的工作越大」在缩小时会自然形成由内向外的时间梯度。
 */
function paperRadius(year: number, minYear: number, maxYear: number): number {
  if (year <= 0) return 4;
  const span = Math.max(1, maxYear - minYear);
  const t = (year - minYear) / span;
  return 3.2 + t * 3.4;
}

export function buildScene(
  graph: Graph,
  layout: GraphLayout,
  seedIds: ReadonlySet<NodeId>,
  opts: SceneOptions = {},
): Scene {
  const { selectedId = null, hoveredId = null, hiddenKinds, minYear = null } = opts;

  const paperNodes = graph.nodes.filter((n) => n.kind === "paper");
  const years = paperNodes.map((p) => p.year).filter((y) => y > 0);
  const minYearData = years.length ? Math.min(...years) : 2000;
  const maxYearData = years.length ? Math.max(...years) : new Date().getFullYear();

  // 节点高光需要知道「它参与了哪些关系」,先扫一遍语义边
  const relationKinds = new Map<NodeId, Set<string>>();
  for (const e of graph.edges) {
    if (!isSemantic(e.kind) || e.layer === "derived") continue;
    for (const end of [e.source, e.target]) {
      const set = relationKinds.get(end) ?? new Set<string>();
      set.add(e.kind);
      relationKinds.set(end, set);
    }
  }

  const index = new Map<NodeId, number>();
  const nodes: SceneNode[] = [];

  for (const node of paperNodes) {
    const pos = layout[node.id];
    if (!pos) continue;
    index.set(node.id, nodes.length);
    nodes.push({
      id: node.id,
      kind: "paper",
      x: pos.x,
      y: pos.y,
      r: paperRadius(node.year, minYearData, maxYearData),
      label: node.title,
      tone: 0,
      year: node.year,
      citations: node.citations,
      seed: seedIds.has(node.id),
      selected: node.id === selectedId,
      hovered: node.id === hoveredId,
      dimmed: minYear !== null && node.year > 0 && node.year < minYear,
      relationKinds: [...(relationKinds.get(node.id) ?? [])],
    });
  }

  // ---------- 社区:质心 + 覆盖半径 ----------
  const communityMembers = new Map<string, SceneNode[]>();
  for (const e of graph.edges) {
    if (e.kind !== "BELONGS_TO") continue;
    const i = index.get(e.source);
    const node = i === undefined ? undefined : nodes[i];
    if (!node) continue;
    const list = communityMembers.get(e.target);
    if (list) list.push(node);
    else communityMembers.set(e.target, [node]);
  }

  const communities: SceneBlob[] = [];
  const communityBlobById = new Map<string, SceneBlob>();

  for (const c of graph.nodes) {
    if (c.kind !== "community") continue;
    const members = communityMembers.get(c.id) ?? [];
    if (members.length < 2) continue;

    const center = centroid(members);
    let r = 0;
    for (const m of members) r = Math.max(r, Math.hypot(m.x - center.x, m.y - center.y));

    const ms = members.map((m) => m.year).filter((y) => y > 0).sort((a, b) => a - b);
    const blob: SceneBlob = {
      id: c.id,
      kind: "community",
      label: c.label,
      labelEn: c.labelEn,
      x: center.x,
      y: center.y,
      r: r * 1.16 + 24,
      tone: c.tone,
      count: members.length,
      medianYear: ms.length ? (ms[Math.floor(ms.length / 2)] ?? 0) : 0,
    };
    communities.push(blob);
    communityBlobById.set(c.id, blob);
  }

  // ---------- 领域:成员社区的加权质心 ----------
  const domains: SceneBlob[] = [];
  for (const d of graph.nodes) {
    if (d.kind !== "domain") continue;

    const blobs = d.memberCommunityIds
      .map((id) => communityBlobById.get(id))
      .filter((b): b is SceneBlob => Boolean(b));
    if (!blobs.length) continue;

    // 按成员数加权,避免小社区把大社区的重心带偏
    let sx = 0;
    let sy = 0;
    let total = 0;
    for (const b of blobs) {
      sx += b.x * b.count;
      sy += b.y * b.count;
      total += b.count;
    }
    const cx = sx / Math.max(1, total);
    const cy = sy / Math.max(1, total);

    let r = 0;
    for (const b of blobs) r = Math.max(r, Math.hypot(b.x - cx, b.y - cy) + b.r);

    domains.push({
      id: d.id,
      kind: "domain",
      label: d.label,
      labelEn: d.labelEn,
      x: cx,
      y: cy,
      r: r * 1.1 + 40,
      tone: d.tone,
      count: d.paperCount,
      medianYear: 0,
    });
  }

  // ---------- 边 ----------
  const edges: SceneEdge[] = [];
  const activeIds = new Set<NodeId>();
  if (selectedId) activeIds.add(selectedId);
  if (hoveredId) activeIds.add(hoveredId);

  for (const e of graph.edges) {
    if (e.kind === "BELONGS_TO" || e.kind === "PART_OF" || e.kind === "HAS_CHUNK") continue;
    if (hiddenKinds?.has(e.kind)) continue;

    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) continue;

    const na = nodes[a];
    const nb = nodes[b];
    // 时间轴过滤:两端都被筛掉才隐藏,一端留下的边仍然有意义
    if (na?.dimmed && nb?.dimmed) continue;

    edges.push({
      id: e.id,
      kind: e.kind,
      layer: e.layer,
      a,
      b,
      directed: e.directed,
      weight: e.weight,
      confidence: e.confidence,
      tone: EDGE_TONE[e.kind] ?? "ink4",
      dash: EDGE_DASH[e.kind] ?? null,
      active: activeIds.size > 0 && (activeIds.has(e.source) || activeIds.has(e.target)),
    });
  }

  return {
    nodes,
    edges,
    communities,
    domains,
    bounds: boundsOf(nodes),
  };
}

function centroid(list: Vec2[]): Vec2 {
  let sx = 0;
  let sy = 0;
  for (const p of list) {
    sx += p.x;
    sy += p.y;
  }
  const n = Math.max(1, list.length);
  return { x: sx / n, y: sy / n };
}

function boundsOf(nodes: SceneNode[]) {
  if (!nodes.length) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r);
    minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    maxY = Math.max(maxY, n.y + n.r);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 命中检测。
 *
 * 判定半径随缩放放宽:否则缩到很小时,星体的屏幕尺寸只有一两个像素,
 * 用户根本点不中。屏幕上的手感一致,靠的就是这里的除法。
 */
export function hitTest(scene: Scene, worldX: number, worldY: number, zoom: number): SceneNode | null {
  const pad = Math.max(6, 11 / Math.max(0.2, zoom));
  let best: SceneNode | null = null;
  let bestD = Infinity;
  for (const n of scene.nodes) {
    const d = Math.hypot(n.x - worldX, n.y - worldY);
    if (d <= n.r + pad && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** 星云命中:点空白处时用来吸附到所在的星团。 */
export function hitBlob(scene: Scene, worldX: number, worldY: number): SceneBlob | null {
  let best: SceneBlob | null = null;
  let bestR = Infinity;
  for (const b of scene.communities) {
    const d = Math.hypot(b.x - worldX, b.y - worldY);
    if (d <= b.r && b.r < bestR) {
      best = b;
      bestR = b.r;
    }
  }
  return best;
}

export function levelHint(level: ViewLevel): string {
  switch (level) {
    case "domain":
      return "领域视图 · 滚轮推近查看研究前沿";
    case "community":
      return "前沿视图 · 继续推近查看单篇论文";
    default:
      return "论文视图 · 点击星体查看详情与证据";
  }
}
