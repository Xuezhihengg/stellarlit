/**
 * StellarLit 知识图谱模型 —— 全系统的唯一数据契约。
 *
 * 设计文档见 docs/知识图谱模型.md。三条必须记住的规则:
 *   1. 按「可核验程度」分三层(layer),不按业务模块分。
 *   2. 语义层(semantic)的每条边必须携带至少一条证据。
 *   3. 依赖方向单向:derived 读 semantic 读 structural,不得反向。
 */

// ---------------------------------------------------------------------------
// 标识符
// ---------------------------------------------------------------------------

/**
 * 节点标识符,格式为 `<类型>:<本地 id>`,例如 `paper:W2626778328`、`concept:transformer`。
 *
 * 用带前缀的字符串而不是各自独立的类型,是为了让同一套 Map / Set 能同时容纳
 * 论文、概念与社区 —— 图算法在遍历时不需要关心节点属于哪一类。
 */
export type NodeId = string;

/** 边标识符。由 `source|kind|target` 派生,保证同一对节点同一关系只有一条边。 */
export type EdgeId = string;

// ---------------------------------------------------------------------------
// 溯源
// ---------------------------------------------------------------------------

/** 数据来源。`algorithm` 指可由本系统复算的派生结果。 */
export type SourceKind = "openalex" | "arxiv" | "semantic-scholar" | "llm" | "algorithm";

/**
 * 一条数据"从哪来"。所有节点与边都必须带它。
 *
 * `model` / `promptVersion` 只在 source 为 llm 时有值 —— 关系判定逻辑一旦变更,
 * 证据链要能说明"这条边是哪个版本的提示词判出来的"。
 */
export interface Provenance {
  source: SourceKind;
  /** 上游记录号或算法名,便于人工复核。 */
  ref?: string;
  model?: string;
  promptVersion?: string;
  /** ISO 8601。 */
  at: string;
}

// ---------------------------------------------------------------------------
// 证据链
// ---------------------------------------------------------------------------

/** 文本块内的定位。缺了它,引用就无法回溯到原文。 */
export interface ChunkLocator {
  chunkId: string;
  /** 该文本块在整篇论文中的字符起止偏移。 */
  start: number;
  end: number;
}

/**
 * 证据。语义层的边靠它把"模型说了什么"变成"原文写了什么"。
 *
 * 五类证据对应五种支撑方式,`kind` 决定界面上如何呈现:
 *   citation    —— 上游引用记录,可点击跳转
 *   span        —— 论文原文片段,展开后可读
 *   metadata    —— 年份/venue/字段等结构化信息
 *   embedding   —— 向量相似度
 *   statistics  —— 统计检验结果
 */
export type Evidence =
  | { kind: "citation"; paperId: NodeId; cites: NodeId; note?: string }
  | {
      kind: "span";
      paperId: NodeId;
      section: PaperSection;
      quote: string;
      locator: ChunkLocator;
      score?: number;
    }
  | { kind: "metadata"; note: string; fields: Record<string, string | number> }
  | { kind: "embedding"; paperId: NodeId; similarity: number; model?: string }
  | { kind: "statistics"; test: string; statistic: number; pValue?: number; adjusted?: boolean };

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

export type NodeKind = "paper" | "author" | "venue" | "concept" | "chunk" | "community" | "domain";

/** 论文的章节。用于把 RAG 的检索结果定位到论文的具体部位。 */
export type PaperSection =
  | "title"
  | "abstract"
  | "introduction"
  | "related-work"
  | "method"
  | "experiment"
  | "conclusion"
  | "other";

/** 概念的细分类型。一个概念可以同时属于多个 kind(例如「对比学习」既是方法也是主题)。 */
export type ConceptKind = "method" | "task" | "dataset" | "metric" | "topic" | "keyword";

/** 上游字段分类,保留原始层级用于多粒度语义核对。 */
export interface FieldTag {
  /** OpenAlex 的 field / subfield / topic 三级,各自保留原始 id。 */
  level: "field" | "subfield" | "topic";
  id: string;
  name: string;
  score?: number;
}

/** 论文 —— 图谱的主角,画面上的一颗星。 */
export interface PaperNode {
  kind: "paper";
  id: NodeId;
  title: string;
  abstract?: string;
  year: number;
  venue?: string;
  citations: number;
  doi?: string;
  arxivId?: string;
  /** 可访问的原文地址(优先 arXiv 全文,其次是出版社页)。 */
  urls: { landing?: string; pdf?: string; fulltext?: string };
  authors: { name: string; id?: NodeId; institution?: string }[];
  fields: FieldTag[];
  /** 是否奠基性工作(被引极高或社区公认),画成实心亮核。 */
  seminal?: boolean;
  /** 是否有开放代码,用于「含代码」筛选。 */
  hasCode?: boolean;
  /** 是否有可解析的图表,用于多模态筛选。 */
  hasFigure?: boolean;
  /** 语义向量的引用键;向量本体存在独立的向量索引里,不进图。 */
  embeddingId?: string;
  provenance: Provenance;
}

/** 作者。默认不显示,用于识别核心作者与团队关系。 */
export interface AuthorNode {
  kind: "author";
  id: NodeId;
  name: string;
  institution?: string;
  orcid?: string;
  /** 在本星空内的论文数,用于排序。 */
  paperCount: number;
  provenance: Provenance;
}

/** 期刊或会议。 */
export interface VenueNode {
  kind: "venue";
  id: NodeId;
  name: string;
  type?: "journal" | "conference" | "preprint" | "workshop" | "book";
  /** CCF 等级等外部评级,没有就留空,不猜。 */
  rank?: string;
  paperCount: number;
  provenance: Provenance;
}

/** 概念:方法 / 任务 / 数据集 / 指标 / 主题 / 关键词。 */
export interface ConceptNode {
  kind: "concept";
  id: NodeId;
  name: string;
  nameEn?: string;
  kinds: ConceptKind[];
  /** 上游字段分类的归属,用于把概念挂回领域层级。 */
  field?: FieldTag;
  /** 本星空内的出现次数,用于决定标签的字号。 */
  weight: number;
  embeddingId?: string;
  provenance: Provenance;
}

/**
 * 文本块 —— RAG 的检索单元。
 *
 * 刻意不作为图上的可见节点:它是"证据的载体"而不是"知识的实体"。
 * 但 `locator` 必填 —— 没有定位的文本块无法支撑可点击的引用角标。
 */
export interface ChunkNode {
  kind: "chunk";
  id: NodeId;
  paperId: NodeId;
  section: PaperSection;
  /** 在同章节内的序号。 */
  order: number;
  text: string;
  locator: ChunkLocator;
  embeddingId?: string;
  provenance: Provenance;
}

/**
 * 社区 —— 研究前沿。
 *
 * 聚合节点不承载事实:它没有自己的数据,只是算法对论文的分组,
 * 重新聚类后被整组替换。因此它不允许作为 CITES 的端点。
 */
export interface CommunityNode {
  kind: "community";
  id: NodeId;
  /** 由高频概念生成的短名,例如「注意力机制」。 */
  label: string;
  labelEn?: string;
  /** 层级树中的深度,0 为最粗。 */
  level: number;
  /** 父社区;顶层社区为 null。 */
  parent: NodeId | null;
  paperIds: NodeId[];
  /** 社区内论文的年份中位数,用于时间轴。 */
  medianYear: number;
  /** 聚类质量:子图模块度。用于判断这个"前沿"是不是真的独立。 */
  modularity: number;
  /** 视觉色调索引,由算法稳定分配,重聚类后保持不变。 */
  tone: number;
  provenance: Provenance;
}

/** 领域 —— 比社区更高一层的聚合,缩小时以星云形态浮现。 */
export interface DomainNode {
  kind: "domain";
  id: NodeId;
  label: string;
  labelEn?: string;
  memberCommunityIds: NodeId[];
  paperCount: number;
  tone: number;
  provenance: Provenance;
}

export type GraphNode =
  | PaperNode
  | AuthorNode
  | VenueNode
  | ConceptNode
  | ChunkNode
  | CommunityNode
  | DomainNode;

// ---------------------------------------------------------------------------
// 边
// ---------------------------------------------------------------------------

/** 结构层关系:来自上游数据源,全部可公开核验。 */
export type StructuralEdgeKind =
  | "CITES"
  | "AUTHORED_BY"
  | "PUBLISHED_IN"
  | "MENTIONS"
  | "HAS_CHUNK";

/**
 * 语义层关系:大模型判定。前六种对应用户可维护的「关系预设」。
 *
 * 这里刻意保留为字面量联合而不是 string:内置关系是编译期可知的,
 * 用户自定义关系走 RelationPreset.id,由运行时校验兜住。
 */
export type SemanticEdgeKind =
  | "BASELINE_OF"
  | "CONTEMPORARY_OF"
  | "SIMILAR_APPROACH"
  | "ALTERNATIVE_TO"
  | "EXTENDS"
  | "CONTRADICTS";

/** 派生层关系:算法算出,给定同样输入必然复现。 */
export type DerivedEdgeKind =
  | "BELONGS_TO"
  | "PART_OF"
  | "SEMANTIC_NEIGHBOR"
  | "POTENTIAL_LINK";

export type EdgeKind = StructuralEdgeKind | SemanticEdgeKind | DerivedEdgeKind;

export type EdgeLayer = "structural" | "semantic" | "derived";

export interface GraphEdge {
  id: EdgeId;
  kind: EdgeKind;
  layer: EdgeLayer;
  source: NodeId;
  target: NodeId;
  directed: boolean;
  /** 0-1。结构层用它做布局强度,派生层用它做统计显著性。 */
  weight: number;
  /** 0-1。只有语义层有真实意义;结构层恒为 1,派生层由算法给出。 */
  confidence: number;
  /** 语义层必须非空(不变式 1)。 */
  evidence: Evidence[];
  /** 语义层:模型给出的判定理由,会展示在证据卡顶部。 */
  rationale?: string;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// 关系预设
// ---------------------------------------------------------------------------

/**
 * 硬约束:在把候选交给大模型之前,先用确定性代码筛一遍。
 *
 * 这一步同时解决两个问题 —— token 成本,以及"模型在明显不该判的关系上瞎判"。
 */
export interface RelationHardConstraints {
  /** 必须存在引用关系(方向由 preset.directed 与 expectCitationDirection 决定)。 */
  requireCitation?: boolean;
  /** 两篇论文之间必须没有互相引用(用于识别"平行但未交汇"的工作)。 */
  requireMutualNonCitation?: boolean;
  /** 年份差上限。 */
  maxYearGap?: number;
  /** 必须共享至少一个 task 概念。 */
  requireSharedTask?: boolean;
  /** 必须共享至少一个 method 概念。 */
  requireSharedMethod?: boolean;
  /** 向量相似度下限。 */
  minSimilarity?: number;
}

/**
 * 关系预设 —— 把提示词工程从代码里搬出来,变成用户可维护、可演示的一等公民。
 *
 * `definition` 与 `negativeExamples` 会一起注入判定提示词。
 * 只给正例是幻觉的主要来源之一:模型不知道边界在哪,就会把"都差不多"判成同一种关系。
 */
export interface RelationPreset {
  id: string;
  label: string;
  labelEn: string;
  /** 一句话定义,展示在设置页与星图图例上。 */
  description: string;
  /** 判定标准,注入提示词。 */
  definition: string;
  /** 反例:什么情况不算。抑制误判的关键。 */
  negativeExamples: string;
  directed: boolean;
  hardConstraints: RelationHardConstraints;
  /**
   * 证据标准 —— 必须与**手头真的有什么数据**对齐。
   *
   *   structural:依据引文结构与元数据即可判定。摘要里通常不会写明
   *              「我们用 X 作为基线」(那写在正文的实验章节),
   *              所以要求逐字引用会把所有候选都判死。
   *   textual:   必须给出可核验的原文片段。用于判断「思路类似」「结论矛盾」
   *              这类只能从内容里读出来的关系。
   *
   * 这条区分是一次实测逼出来的:六类关系全部 matched = 0,
   * 原因就是拿 textal 的标准去要求 structural 的关系。
   */
  evidencePolicy: "structural" | "textual";
  visual: { tone: string; dash?: string };
  /** 判定逻辑或提示词变更时必须自增 —— 证据链据此可追溯。 */
  promptVersion: string;
  enabled: boolean;
  /** 每篇种子最多产出多少条,控制成本与画面噪声。 */
  maxPerSeed: number;
  /** 内置预设不可删除,但可以停用与改写判定标准。 */
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// 图
// ---------------------------------------------------------------------------

export interface GraphStats {
  papers: number;
  edges: number;
  communities: number;
  domains: number;
  byLayer: Record<EdgeLayer, number>;
}

/**
 * 一份图谱载荷。节点用数组而不是 Map:它要经过 JSON 序列化跨网络传输,
 * 前端拿到后再按需索引。
 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

/** 节点在世界坐标系中的位置。原点固定在世界中心 —— 世界只对称长大,不平移。 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 布局:节点 id → 世界坐标。
 *
 * 坐标是**持久属性**:增量构建时老节点作为锚点被拉回原位,
 * 否则用户看到的现象是"我一搜,原来的星图就没了"。
 */
export type GraphLayout = Record<NodeId, Vec2>;

// ---------------------------------------------------------------------------
// 不变式校验
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  edgeId?: EdgeId;
  nodeId?: NodeId;
  rule: string;
  detail: string;
}

/**
 * 图算法与视图层都用不到校验结果,但写入图之前必须过一遍。
 * 违反不变式的数据一律拒绝入库,而不是静默丢弃 —— 静默丢弃会让问题在很久以后才暴露。
 */
export type InvariantCheck = (graph: Graph) => InvariantViolation[];
