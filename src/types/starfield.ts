/**
 * 星空 —— 图谱的时间维度。
 *
 * 一次搜索换一张图是工具;一片会长大的星空是工作台。
 * 用户可以在同一片星空下多次输入种子,增量构建。
 */

import type { NodeId } from "./kg";

/** 种子的解析结果 —— 永远返回候选列表,由用户确认,不替用户决定。 */
export interface SeedCandidate {
  id: NodeId;
  title: string;
  year: number;
  venue?: string;
  citations: number;
  authors: string[];
  /** 0-1。标题相似度与年份偏差的加权结果。 */
  confidence: number;
  /** 为什么推荐这一条 —— 展示给用户,而不是让他盲选。 */
  reason: string;
  /** 已经在本星空里,变成「并入」而不是「新增」。 */
  alreadyInStarfield: boolean;
}

/** 一次种子输入。星空由多次输入累积而成,这里保留构建顺序。 */
export interface SeedEntry {
  /** 本次输入时用户敲的原文。 */
  query: string;
  paperId: NodeId;
  /** 并入星空的时间。 */
  addedAt: string;
  /** 本次并入带来的新论文数,用于展示"这一步长出了多少"。 */
  addedPapers: number;
}

export interface StarfieldViewport {
  x: number;
  y: number;
  scale: number;
}

export interface StarfieldStats {
  papers: number;
  edges: number;
  communities: number;
  domains: number;
}

/**
 * 一片星空。
 *
 * `viewport` 会被持久化:用户下次打开这片星空,看到的是上次离开时的视角,
 * 而不是被重置到初始缩放。
 */
export interface Starfield {
  id: string;
  name: string;
  ownerId: string;
  seeds: SeedEntry[];
  createdAt: string;
  updatedAt: string;
  viewport: StarfieldViewport;
  stats: StarfieldStats;
}

/** 历史列表用的摘要,不含图谱本体。 */
export interface StarfieldSummary {
  id: string;
  name: string;
  seedTitles: string[];
  updatedAt: string;
  stats: StarfieldStats;
}

/**
 * 视图层级 —— 语义缩放把"缩放比例"翻译成"抽象层级"。
 *
 * 三个层级不是三套界面,而是同一张图的三种读法:
 *   domain  缩到最远,看到的是领域星云与标题
 *   community 中间层,星团与社区标签浮现
 *   paper   推近,看到论文星体与关系边
 */
export type ViewLevel = "domain" | "community" | "paper";

/** 由相机缩放比推导当前视图层级。阈值集中在这里,避免散落在组件里。 */
export const VIEW_LEVEL_THRESHOLDS = {
  /** scale < 此值 → domain 层 */
  domain: 0.34,
  /** scale < 此值 → community 层;大于等于则进入 paper 层 */
  community: 0.78,
} as const;

export function viewLevelOf(scale: number): ViewLevel {
  if (scale < VIEW_LEVEL_THRESHOLDS.domain) return "domain";
  if (scale < VIEW_LEVEL_THRESHOLDS.community) return "community";
  return "paper";
}
