/**
 * 证据充分性判定 —— Agent 的「什么时候可以停」。
 *
 * 这里不调用模型:判定必须可解释、可复现,也不能因为模型余额不足就失去
 * 停止能力。规则只回答三件事:
 *   1. 问题属于关系型、外部检索型,还是一般问答;
 *   2. 当前证据有没有覆盖问题里提到的论文与关键概念;
 *   3. 还缺什么,交给下一轮规划去补。
 */

import { tokenizeForSearch } from "@/lib/rag/text";
import type { StarfieldPayload } from "@/types/api";
import type { AskEvidenceStats, ImageEvidence } from "@/types/rag";
import type { PaperNode } from "@/types/kg";

import type { RetrievalDiagnostics, RetrievedSource } from "../rag/retrieve";
import { EXTERNAL_CUES, RELATION_CUES, papersMentioned } from "./plan";

export type AskIntent = "relation" | "comparison" | "external" | "general";

export interface EvidenceAssessment {
  enough: boolean;
  intent: AskIntent;
  gaps: string[];
  stats: AskEvidenceStats;
}

const COMPARISON_CUES = /比较|对比|区别|差异|相比|\bvs\.?\b/i;

/** 这些词几乎出现在每个问题里,算进覆盖率只会让「证据足够」虚高。 */
const STOP_TOKENS = new Set([
  "什么",
  "哪些",
  "怎么",
  "如何",
  "为什么",
  "之间",
  "论文",
  "工作",
  "关系",
  "是否",
  "可以",
  "一下",
  "这些",
  "那些",
  "这篇",
  "它们",
  "有哪",
  "么关",
  "么样",
  "介绍",
  "讲讲",
  "分别",
]);

function paperNodes(payload: StarfieldPayload): PaperNode[] {
  return payload.graph.nodes.filter((node): node is PaperNode => node.kind === "paper");
}

/** 问题里的实词有多少能在这批证据里找到;中文按 bigram,英文按词。 */
function coverageOf(
  question: string,
  sources: RetrievedSource[],
  imageEvidence: ImageEvidence[] = [],
): number {
  const wanted = new Set(
    tokenizeForSearch(question).filter((token) => token.length >= 2 && !STOP_TOKENS.has(token)),
  );
  if (!wanted.size) return 1;

  const haystack = [
    ...sources.map((source) => `${source.title} ${source.text}`),
    ...imageEvidence.map(
      (item) => `${item.title} ${item.quote} ${item.numbers.join(" ")}`,
    ),
  ]
    .join(" ")
    .toLowerCase();
  let hit = 0;
  for (const token of wanted) {
    if (haystack.includes(token)) hit++;
  }
  return hit / wanted.size;
}

function relationCovering(sources: RetrievedSource[], ids: string[]): RetrievedSource | undefined {
  if (ids.length < 2) return undefined;
  return sources.find(
    (source) => source.section === "relation" && ids.every((id) => source.paperIds.includes(id)),
  );
}

/**
 * 判定当前证据是否足够回答。
 *
 * 宁可少补一轮,也不要把「没命中」误判成「没证据」:默认检索通常已经
 * 带回 8 块原文,只有明确的缺口(关系没查到、外部结果为空、提到的论文
 * 没覆盖)才继续。
 */
export function assessEvidence(
  payload: StarfieldPayload,
  question: string,
  sources: RetrievedSource[],
  external: string[],
  retrieval?: RetrievalDiagnostics,
  imageEvidence: ImageEvidence[] = [],
): EvidenceAssessment {
  const relationCue = RELATION_CUES.test(question);
  const comparisonCue = COMPARISON_CUES.test(question);
  const externalCue = EXTERNAL_CUES.test(question);
  const intent: AskIntent = comparisonCue
    ? "comparison"
    : relationCue
      ? "relation"
      : externalCue
        ? "external"
        : "general";

  const mentioned = papersMentioned(paperNodes(payload), question).slice(0, 3);
  const mentionedIds = mentioned.map((paper) => paper.id);
  const covered = new Set(sources.flatMap((source) => source.paperIds));
  const pairRelation = relationCovering(sources, mentionedIds);
  const hasImageEvidence = imageEvidence.length > 0;
  const coverage = coverageOf(question, sources, imageEvidence);
  // 图像块通常只有 OCR/图例/若干数据点,天然比摘要短;问图时用更低但仍有约束的门槛。
  const visualCue = /图|图表|曲线|坐标|轴|数值|趋势|截图|ocr|image|chart|figure/i.test(question);
  const coverageThreshold = hasImageEvidence && visualCue ? 0.22 : 0.32;
  const gaps: string[] = [];

  if (mentioned.length >= 2 && (intent === "relation" || intent === "comparison")) {
    if (!pairRelation) {
      gaps.push(
        `还缺《${mentioned[0]!.title}》与《${mentioned[1]!.title}》之间的关系证据`,
      );
    }
  }

  for (const paper of mentioned) {
    if (!covered.has(paper.id)) gaps.push(`还缺《${paper.title}》的原文证据`);
  }

  if (externalCue && external.length === 0) {
    gaps.push("还没有检索到后续或引用工作");
  }

  if (!sources.length && !hasImageEvidence) {
    gaps.push("星空内没有命中任何原文");
  } else if (sources.length < 3 && !pairRelation && !hasImageEvidence) {
    gaps.push("命中的原文过少");
  } else if (coverage < coverageThreshold) {
    gaps.push("检索结果没有覆盖问题的关键概念");
  }

  // 默认检索自身已低于置信门槛时补一次工具查询;工具一旦带来新证据,
  // 后面的判定会重新计算覆盖率,不会把这句缺口永久挂住。
  if (
    !hasImageEvidence &&
    retrieval &&
    !retrieval.enough &&
    sources.length <= retrieval.sourceCount + 1
  ) {
    gaps.push(
      `检索置信度 ${(retrieval.coverage * 100).toFixed(0)}% 低于 ${(retrieval.threshold * 100).toFixed(0)}% 门槛`,
    );
  }

  const paperSet = new Set(sources.flatMap((source) => source.paperIds));
  const stats: AskEvidenceStats = {
    sources: sources.length,
    relations: sources.filter((source) => source.section === "relation").length,
    papers: paperSet.size,
    external: external.length,
    images: new Set(imageEvidence.map((item) => item.imageIndex)).size,
    imageChunks: imageEvidence.length,
    mode: retrieval?.mode,
    coverage: Number(coverage.toFixed(3)),
  };

  return { enough: gaps.length === 0, intent, gaps, stats };
}
