/**
 * API 契约 —— 前端与服务端之间唯一的形状约定。
 *
 * 服务端的每一层(数据源、图算法、模型)都有自己的内部类型,
 * 但它们出口时必须收敛到这里定义的结构:前端只认识这一套,
 * 上游换数据源不会波及界面。
 */

import type { Graph, GraphLayout, RelationPreset } from "./kg";
import type { SeedCandidate, Starfield, StarfieldSummary } from "./starfield";

/** 当前服务端具备哪些能力。缺密钥时界面据此如实降级,而不是假装有 AI 结论。 */
export interface CapabilityReport {
  llm: boolean;
  embedding: boolean;
  llmModel: string | null;
}

export interface QualitySummaryDto {
  kept: number;
  droppedTotal: number;
  droppedByReason: Record<string, number>;
}

export interface RelationReportDto {
  perPreset: Record<
    string,
    { candidates: number; judged: number; matched: number; mode: "llm" | "heuristic" }
  >;
  /** 被引用核验拦下的、模型编造的原文片段数 */
  rejectedQuotes: number;
  llmCalls: number;
  estimatedTokens: number;
  cacheHits: number;
  batchFallbacks: number;
}

export interface BuildMeta {
  quality: QualitySummaryDto;
  relations: RelationReportDto;
  capabilities: CapabilityReport;
  builtAt: string;
  durationMs: number;
  /** 本次构建并入的新论文数 */
  addedPapers: number;
}

/** 一片星空的完整载荷。前端拿到它就能画出整张图。 */
export interface StarfieldPayload {
  starfield: Starfield;
  graph: Graph;
  layout: GraphLayout;
  presets: RelationPreset[];
  meta: BuildMeta;
}

// ---------------------------------------------------------------------------
// 请求 / 响应
// ---------------------------------------------------------------------------

export interface ResolveSeedRequest {
  query: string;
  /** 当前星空里已有的论文 id,用于把候选标成「并入」而不是「新增」 */
  knownPaperIds?: string[];
}

export interface ResolveSeedResponse {
  candidates: SeedCandidate[];
}

export interface GrowRequest {
  /** 星空 id;留空表示新建一片星空 */
  starfieldId?: string;
  /** 用户确认后的种子论文节点 id */
  seedPaperId: string;
  /** 星空名称(新建时使用,留空则由种子标题生成) */
  name?: string;
  /** 单次构建的论文预算上限 */
  budget?: number;
  /** 候选池宽度:每个种子向后 / 向前各抓多少篇,不影响入图数量 */
  pool?: number;
  /** 每类关系送审多少对候选 —— 直接决定模型成本与语义图的稠密程度 */
  judgeDepth?: number;
  /**
   * 关系预设覆盖。
   *
   * 设置页允许用户改写判定标准与反例 —— 那是提示词工程的一部分,
   * 不该被锁在代码里。请求带上它,服务端就用这一份跑判定。
   */
  presets?: RelationPreset[];
}

export type GrowResponse = StarfieldPayload;

export interface ListStarfieldsResponse {
  items: StarfieldSummary[];
}

export interface ApiError {
  error: string;
  /** 面向用户的可行动建议,而不是堆栈 */
  hint?: string;
  code?: string;
}
