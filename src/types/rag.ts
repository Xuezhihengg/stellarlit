/** RAG 问答的请求与流式事件。前后端共用,避免两边各写一份形状。 */

export interface AskRequest {
  starfieldId: string;
  question: string;
  /** 最多 MAX_ASK_IMAGES 张;顺序即发送顺序 */
  images?: AskImage[];
}

/** 一次提问最多附几张图。上限由服务端与界面共用,避免两边各写一个数字。 */
export const MAX_ASK_IMAGES = 4;

export interface AskImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** 不含 data URL 前缀的 base64 */
  data: string;
  name: string;
}

/** 图像证据在原图中的归一化区域,左上角为原点,宽高均在 0-1 之间。 */
export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ImageEvidenceKind =
  | "caption"
  | "ocr"
  | "chart"
  | "table"
  | "numeric"
  | "trend";

/**
 * 从一张附图里切出的可检索证据。
 *
 * OCR 文本、表头、坐标轴、关键数值与趋势分别成块,而不是把整张图塞进 prompt。
 * label 同时用于回答角标([图1-2])和前端定位到原图区域。
 */
export interface ImageEvidence {
  id: string;
  /** 对应提问时附图的顺序,从 0 开始 */
  imageIndex: number;
  /** 图1-1:第 1 张图的第 1 个证据块 */
  label: string;
  kind: ImageEvidenceKind;
  title: string;
  quote: string;
  numbers: string[];
  region?: ImageRegion;
}

export interface AskImageIndexStats {
  images: number;
  chunks: number;
  numbers: number;
  cached: number;
  /** 有图片没完成结构化抽取,只能按原图兜底 */
  degraded: boolean;
}

export interface AskSource {
  /** 回答里的角标编号,从 1 开始 */
  n: number;
  chunkId: string;
  paperId: string;
  paperIds: string[];
  title: string;
  section: "title" | "abstract" | "relation";
  year?: number;
  /** 证据摘录 */
  quote: string;
}

/** 回答里提到、但当前星空还没有的论文;是否加入由用户确认。 */
export interface AskSuggestion {
  title: string;
  year?: number;
  reason?: string;
}

/** Agent 执行轨迹里的一步:给用户看「它自己决定查了什么」。 */
export interface AskStep {
  /** 跨轮次的全局步号(从 0 开始):同一工具被调用两次时用来区分 */
  slot: number;
  /** 第几轮决策(从 1 开始):第一轮规划与后续补查分开显示 */
  round: number;
  /** MCP 工具名,例如 search_starfield */
  tool: string;
  /** 人话标签,例如「检索原文」 */
  label: string;
  state: "running" | "done" | "empty" | "failed";
  /** 结果摘要,例如「6 块 · 单阶段检测」 */
  detail?: string;
  /** 规划器给出的理由;悬停时展示,不占正文空间 */
  why?: string;
}

/** 当前轮检索到的证据规模,用于解释「为什么停/为什么继续」。 */
export interface AskEvidenceStats {
  sources: number;
  relations: number;
  papers: number;
  external: number;
  /** 本次附图数量与抽出的图块数量 */
  images?: number;
  imageChunks?: number;
  /** 混合召回的实际模式:向量不可用时如实显示为词面召回。 */
  mode?: "hybrid" | "lexical";
  /** 问题关键概念在证据里的覆盖率,0-1。 */
  coverage?: number;
}

export type AskDecisionCode =
  | "enough"
  | "continue"
  | "no_new_evidence"
  | "max_rounds"
  | "max_steps"
  | "no_more_tools";

/** Agent 每轮结束后的判定:继续补查,还是带着现有证据停止。 */
export interface AskDecision {
  round: number;
  action: "continue" | "stop";
  code: AskDecisionCode;
  /** 人话解释,直接显示在轨迹里 */
  reason: string;
  /** 仍未覆盖的证据缺口;足够时为空数组 */
  gaps: string[];
  stats: AskEvidenceStats;
}

export type AskEvent =
  | { type: "sources"; sources: AskSource[] }
  | {
      type: "imageEvidence";
      evidence: ImageEvidence[];
      stats: AskImageIndexStats;
    }
  | { type: "activity"; step: AskStep }
  | { type: "decision"; decision: AskDecision }
  | { type: "delta"; text: string }
  | {
      type: "done";
      citations: number[];
      fallback?: boolean;
      /** fallback 时说明原因,例如「模型账户余额不足」 */
      fallbackReason?: string;
      suggestions?: AskSuggestion[];
    }
  | { type: "error"; message: string };

/**
 * 一条问答历史。
 *
 * 存在服务端 SQLite 里(不再只活在 localStorage),所以类型放在共享层:
 * 前端渲染、API 校验、数据库读写用的是同一个形状。
 */
export interface AskHistoryEntry {
  id: string;
  createdAt: number;
  question: string;
  answer: string;
  sources: AskSource[];
  citations: number[];
  suggestions: AskSuggestion[];
  fallback: boolean;
  /** 当时随问题发送了几张图;不存文件名,历史里只需知道"带过图" */
  imageCount?: number;
  /** 从附图抽取出的 OCR / 表格 / 图表块,用于历史里重新渲染可点击证据 */
  imageEvidence?: ImageEvidence[];
  /** 图片预览的对象 URL(服务端存 key);只用于回放定位,不保存原始大图 */
  imagePreviews?: string[];
  /** 当时的 Agent 轨迹与每轮判定;旧记录没有这两个字段 */
  trace?: AskStep[];
  decisions?: AskDecision[];
}

export interface AskHistoryResponse {
  entries: AskHistorySummary[];
}

/** 历史列表项:只含渲染列表需要的字段,完整内容按 id 再取。 */
export interface AskHistorySummary {
  id: string;
  createdAt: number;
  question: string;
  /** 截断后的回答,仅用于列表预览 */
  answer: string;
  imageCount?: number;
}
