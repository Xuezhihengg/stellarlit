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
  /** 被时间轴或关系筛选淡出的星:画成暗星而不是消失 */
  dimmed: boolean;
  /** 该节点相关的关系类型集合,决定高光色 */
  relationKinds: string[];
  /** 这一颗星自己的运动节律 */
  motion: StarMotion;
}

/**
 * 星体的运动参数。
 *
 * 每一颗星有自己的振幅、相位与闪烁频率 —— 整片星空用同一套参数的话,
 * 会一起明一起暗、一起漂,看起来像在呼吸而不是"活"。
 *
 * 参数由**节点 id** 派生,不是由下标派生:增量构建时下标的顺序会变,
 * 而 id 不变。用下标的话,加一篇论文就会让别的星突然跳到另一个节律上。
 */
export interface StarMotion {
  /** 漂浮振幅(世界像素) */
  amp: number;
  /** 漂浮角速度 */
  spd: number;
  phx: number;
  phy: number;
  /** 视差深度:越大越"近",鼠标移动时位移越多 */
  dp: number;
  /** 闪烁相位与频率 */
  tw: number;
  tws: number;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function motionOf(id: string): StarMotion {
  // FNV-1a:把 id 摊成一个稳定的数,再派生 8 个互不相关的参数
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const base = (h >>> 0) / 4294967296;
  const k = (i: number) => hash01(base * 1000 + i * 7.13);
  return {
    // 振幅与速度都比"刚好看得出来"再大一点:星图是给人看的,
    // 动得太含蓄等于没有动 —— 但也不能大到让人读不出坐标
    amp: 2.6 + k(0) * 5.2,
    spd: 0.16 + k(1) * 0.3,
    phx: k(2) * Math.PI * 2,
    phy: k(3) * Math.PI * 2,
    dp: 0.35 + k(4) * 0.65,
    tw: k(5) * Math.PI * 2,
    tws: 0.9 + k(6) * 1.2,
  };
}

export interface SceneEdge {
  id: string;
  kind: GraphEdge["kind"];
  layer: GraphEdge["layer"];
  /** 指向 Scene.nodes 的下标 */
  a: number;
  b: number;
  directed: boolean;
  /**
   * 原始的引用方向,存的是 Scene.nodes 的下标。
   *
   * `a`/`b` 为了去重被规范化成"小下标在前",方向信息就丢了。
   * 而引用是**有向**的,画面上必须能看出"谁引用了谁" ——
   * 所以方向单独留一份,不跟去重用的下标混在一起。
   */
  from: number;
  to: number;
  weight: number;
  confidence: number;
  tone: EdgeToneKey;
  dash: number[] | null;
  /** 两端至少有一端是高亮节点 */
  active: boolean;
  /** 所属关系类型被关掉:淡出,但保留在画面上 */
  faded: boolean;
  /**
   * 写在边旁边的文字 —— **只含语义关系**。
   *
   * 引用和语义可能落在同一对论文之间而被合并成一条边。
   * 合并时若把"引用"也写进标签,就等于又回到"用文字表示引用"的老路,
   * 而引用方向现在是由流动的粒子表达的。
   */
  label: string;
  /**
   * 这一对论文之间**全部**关系的类型名。
   *
   * 同一对论文可能同时满足多种关系(既同期、又同任务异方法)。
   * 早期版本把每条关系各画一条线,结果两篇论文之间叠着三根几乎重合的曲线,
   * 看起来像画错了。现在的做法是:一对论文只画**一条**边,
   * 把关系类型合并成标签写在边上 —— 线的数量表达"有多少对相关",
   * 标签表达"怎么相关"。
   */
  kinds: string[];
  /**
   * 这条边背后**是否也有一条引用**。
   *
   * 合并之后 kind 取的是语义类型,引用那条被"吃掉"了 ——
   * 但关系并没有消失:基线关系往往正是建立在引用之上的。
   * 所以方向信息要单独留一个标志,不能靠 kind 反推。
   */
  hasCitation: boolean;
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
  /**
   * 领域云由**多个柔球融合**而成,而不是一个圆。
   *
   * 做法:每个成员社区放一个大球,再沿社区之间的连线每隔约 95px 插一个球 ——
   * 于是云是"长"出来的、边界是有机的,而不是一个规整的圆。
   * 这是参考稿里最容易被忽略的一处细节,也是"星云"与"色块"的区别所在。
   */
  blobs?: Array<{ x: number; y: number; r: number }>;
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
  /**
   * 用户**关掉**了哪些关系类型。
   *
   * 语义是"淡出"而不是"隐藏":直接抽掉会让图的形状整个变一次,
   * 用户失去空间记忆 —— 关掉一类关系后,剩下的星体应该还在原位,
   * 只是不再被那种关系点亮。所以星星与对应的边一起变暗。
   */
  dimmedKinds?: ReadonlySet<string>;
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

/** 关系类型的中文名。写在边上,让"这条线是什么意思"不需要去对照图例。 */
const EDGE_LABEL: Record<string, string> = {
  CITES: "引用",
  BASELINE_OF: "基线",
  CONTEMPORARY_OF: "同期",
  SIMILAR_APPROACH: "思路类似",
  ALTERNATIVE_TO: "同任务异方法",
  EXTENDS: "扩展",
  CONTRADICTS: "结论矛盾",
  POTENTIAL_LINK: "潜在连接",
  SEMANTIC_NEIGHBOR: "语义近邻",
};

/**
 * 所有关系都用实线。
 *
 * 曾经用虚线区分"同期"(平行但未交汇),但虚线在弧线上会断成一段段,
 * 弧线的走向反而读不出来了 —— 而走向正是这条边唯一的信息。
 * 关系类型的区分交给颜色与边上的文字,线型统一。
 */
const SOLID: number[] | null = null;

const isSemantic = (kind: string): boolean =>
  kind !== "CITES" && kind !== "MENTIONS" && kind !== "AUTHORED_BY" && kind !== "PUBLISHED_IN";

/**
 * 论文的视觉半径。
 *
 * 半径跟**年份**相关而不是跟被引量相关:被引量已经用亮度表达了,
 * 两个通道表达同一个变量是浪费。年份映射到大小之后,
 * 「越新的工作越大」在缩小时会自然形成由内向外的时间梯度。
 */
/**
 * 论文的视觉半径 —— 由**引用量**决定。
 *
 * 用对数而不是线性:引用量是重尾分布的,线性映射会让少数几篇高被引
 * 把其余全部压成一个点。取对数之后,"1 万引"和"100 引"的差距
 * 仍然看得出来,但"1000 引"与"1100 引"不会差出一个量级。
 */
function paperRadius(citations: number, maxCitations: number): number {
  const t = Math.log10(Math.max(1, citations) + 1) / Math.log10(Math.max(10, maxCitations) + 1);
  /**
   * 指数 1.6 与更小的基数,解决两个问题:
   *   1. 之前"普遍偏大" —— 基数从 2.6 降到 1.4
   *   2. 之前"引用量的差异不明显" —— 对数映射之后中低被引的论文
   *      全挤在 0.3~0.5 这一段,再取 1.6 次方把它们拉开,
   *      高被引才真正"鹤立鸡群"
   */
  return 1.4 + Math.pow(Math.max(0, Math.min(1, t)), 1.6) * 5.6;
}

export function buildScene(
  graph: Graph,
  layout: GraphLayout,
  seedIds: ReadonlySet<NodeId>,
  opts: SceneOptions = {},
): Scene {
  const { selectedId = null, hoveredId = null, dimmedKinds, minYear = null } = opts;

  const paperNodes = graph.nodes.filter((n) => n.kind === "paper");
  const maxCitations = paperNodes.reduce((m, p) => Math.max(m, p.citations), 10);

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
      r: paperRadius(node.citations, maxCitations),
      label: node.title,
      tone: 0,
      year: node.year,
      citations: node.citations,
      seed: seedIds.has(node.id),
      selected: node.id === selectedId,
      hovered: node.id === hoveredId,
      dimmed:
        (minYear !== null && node.year > 0 && node.year < minYear) ||
        (dimmedKinds?.size ? allKindsDimmed(relationKinds.get(node.id), dimmedKinds) : false),
      relationKinds: [...(relationKinds.get(node.id) ?? [])],
      motion: motionOf(node.id),
    });
  }

  // ---------- 社区:质心 + 覆盖半径 ----------
  const communityMembers = new Map<string, SceneNode[]>();
  const communityTone = new Map<string, number>();
  for (const c of graph.nodes) {
    if (c.kind === "community") communityTone.set(c.id, c.tone);
  }
  for (const e of graph.edges) {
    if (e.kind !== "BELONGS_TO") continue;
    const i = index.get(e.source);
    const node = i === undefined ? undefined : nodes[i];
    if (!node) continue;
    // 把所属前沿的色调写到星体上:光晕靠它上色,于是"哪些星是一伙的"一眼可读
    node.tone = communityTone.get(e.target) ?? 0;
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

    // 成员社区各放一个球,再在两两之间按约 95px 的间距插球 → 融合成一片有机的云
    const fused: Array<{ x: number; y: number; r: number }> = blobs.map((b) => ({
      x: b.x,
      y: b.y,
      r: b.r * 1.06,
    }));
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const A = blobs[i];
        const B = blobs[j];
        if (!A || !B) continue;
        const dist = Math.hypot(A.x - B.x, A.y - B.y);
        const n = Math.max(2, Math.round(dist / 95));
        for (let k = 1; k < n; k++) {
          const t = k / n;
          fused.push({
            x: A.x + (B.x - A.x) * t,
            y: A.y + (B.y - A.y) * t,
            r: Math.min(A.r, B.r) * 0.94,
          });
        }
      }
    }

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
      blobs: fused,
    });
  }

  // ---------- 边 ----------
  const edges: SceneEdge[] = [];
  const activeIds = new Set<NodeId>();
  if (selectedId) activeIds.add(selectedId);
  if (hoveredId) activeIds.add(hoveredId);

  /**
   * 一对论文只保留一条边。
   *
   * 冲突时的取舍:语义边优先于引用边 —— 引用是骨架,到处都有;
   * 语义是结论,稀有且是用户真正要看的。同层之间保留置信度更高的那条,
   * 但**所有**被合并的关系名都会写进 kinds,标签上一个都不会丢。
   */
  const byPair = new Map<string, SceneEdge>();

  for (const e of graph.edges) {
    if (e.kind === "BELONGS_TO" || e.kind === "PART_OF" || e.kind === "HAS_CHUNK") continue;

    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;

    const na = nodes[a];
    const nb = nodes[b];
    // 时间轴过滤:两端都被筛掉才隐藏,一端留下的边仍然有意义
    if (na?.dimmed && nb?.dimmed) continue;

    const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
    const layer: "structural" | "semantic" = e.layer === "semantic" ? "semantic" : "structural";
    const candidate: SceneEdge = {
      id: e.id,
      kind: e.kind,
      layer,
      a: Math.min(a, b),
      b: Math.max(a, b),
      from: a,
      to: b,
      directed: e.directed,
      weight: e.weight,
      confidence: e.confidence,
      tone: EDGE_TONE[e.kind] ?? "ink4",
      dash: SOLID,
      active: activeIds.size > 0 && (activeIds.has(e.source) || activeIds.has(e.target)),
      faded: Boolean(dimmedKinds?.has(e.kind)),
      label: layer === "semantic" ? (EDGE_LABEL[e.kind] ?? e.kind) : "",
      kinds: [EDGE_LABEL[e.kind] ?? e.kind],
      hasCitation: e.kind === "CITES",
    };

    const prev = byPair.get(key);
    if (!prev) {
      byPair.set(key, candidate);
      continue;
    }

    // 合并:语义优先,其次比置信度
    const preferNew =
      (candidate.layer === "semantic" && prev.layer === "structural") ||
      (candidate.layer === prev.layer && candidate.confidence > prev.confidence);

    const mergedKinds = [...new Set([...prev.kinds, ...candidate.kinds])];
    const winner = preferNew ? candidate : prev;
    // 标签只保留语义关系;引用交给粒子去表达
    const semanticLabels = [
      ...new Set([prev.label, candidate.label].filter((x) => x.length > 0)),
    ];
    byPair.set(key, {
      ...winner,
      kinds: mergedKinds,
      label: semanticLabels.join(" · "),
      // 只要有一个关系没被关掉,这条边就仍然算"可见"
      faded: prev.faded && candidate.faded,
      // 只要其中之一是引用,这条边的方向就值得用粒子表达
      hasCitation: prev.hasCitation || candidate.hasCitation,
      active: prev.active || candidate.active,
    });
  }

  edges.push(...byPair.values());

  return {
    nodes,
    edges,
    communities,
    domains,
    bounds: boundsOf(nodes),
  };
}

/**
 * 一颗星是否该被"关系筛选"淡出。
 *
 * 注意这里必须有 **length > 0** 这一条:数组为空时 `every()` 返回 true,
 * 于是"没有任何语义关系的星"会被判定为"它的关系全被关掉了"而整片淡出。
 * 引用边不算在内 —— 关掉引用边不该影响任何一颗星的明暗,它只是骨架。
 */
function allKindsDimmed(kinds: Iterable<string> | undefined, dimmed: ReadonlySet<string>): boolean {
  if (!kinds) return false;
  const list = [...kinds];
  return list.length > 0 && list.every((k) => dimmed.has(k));
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
