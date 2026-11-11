/**
 * RAG 语料 —— 把一片星空翻译成可供检索的文本块。
 *
 * 三类块:
 *   title    —— 一篇论文的元信息(年份、venue、作者、被引)
 *   abstract —— 摘要按句切块(带字符定位)
 *   relation —— 一条已验证语义关系的理由与原文证据
 *
 * 为什么要收 relation 块:用户最常问的不是"这篇讲了什么",而是
 * "这几篇之间是什么关系、凭什么"。关系证据本来就是我们最可信的资产,
 * 让它进入检索,回答才能落到证据上。
 */

import { chunkText, tokenizeForSearch } from "@/lib/rag/text";
import { formatPaperText } from "@/lib/format";
import { edgeLabelForKind } from "@/lib/graph/edge-kinds";
import { edgeKindLabel } from "@/lib/graph/edge-labels";
import type { StarfieldPayload } from "@/types/api";
import type { GraphEdge, PaperNode } from "@/types/kg";

export type RagSection = "title" | "abstract" | "relation";

export interface RagSource {
  chunkId: string;
  /** 主论文(关系块取其一) */
  paperId: string;
  /** 涉及的全部论文:点角标时用来选中/聚焦 */
  paperIds: string[];
  title: string;
  section: RagSection;
  year?: number;
  /** 全文块文本,用于生成与引用 */
  text: string;
  /** 展示给用户的证据片段(通常就是 text 的前几句) */
  quote: string;
}

export interface RagChunk extends RagSource {
  tokens: string[];
}

export interface RagCorpus {
  starfieldId: string;
  chunks: RagChunk[];
}

/** 关系块标题里用短标题,避免把两个长标题拼成一段噪声。 */
function shortTitle(title: string, max = 42): string {
  return title.length <= max ? title : `${title.slice(0, max - 1)}…`;
}

function evidenceText(edge: GraphEdge): string {
  const parts: string[] = [];
  if (edge.rationale) parts.push(edge.rationale);
  for (const ev of edge.evidence) {
    if (ev.kind === "span" && ev.quote) parts.push(`原文:「${formatPaperText(ev.quote)}」`);
    if (ev.kind === "citation") parts.push("依据:上游引用记录");
    if (ev.kind === "metadata" && ev.note) parts.push(`依据:${ev.note}`);
  }
  return parts.join(" ");
}

/** 把一条语义边压成检索块。语料与 Agent 工具结果共用,保证 chunkId 一致、能去重。 */
export function relationSource(
  edge: GraphEdge,
  a: PaperNode,
  b: PaperNode,
  label = edgeKindLabel(edge.kind),
): RagSource {
  const aTitle = formatPaperText(a.title);
  const bTitle = formatPaperText(b.title);
  const body = [
    `关系类型:${label}`,
    `《${aTitle}》(${a.year || "年份未知"})与《${bTitle}》(${b.year || "年份未知"})`,
    evidenceText(edge),
    `判定置信度 ${(edge.confidence * 100).toFixed(0)}%`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    chunkId: `edge:${edge.id}`,
    paperId: a.id,
    paperIds: [a.id, b.id],
    title: `${shortTitle(aTitle)} ↔ ${shortTitle(bTitle)}`,
    section: "relation",
    year: a.year || undefined,
    text: body,
    quote: body.slice(0, 220),
  };
}

export function buildCorpus(payload: StarfieldPayload): RagCorpus {
  const papers = payload.graph.nodes.filter((n): n is PaperNode => n.kind === "paper");
  const byId = new Map(papers.map((p) => [p.id, p]));
  const chunks: RagChunk[] = [];

  for (const paper of papers) {
    const paperTitle = formatPaperText(paper.title);
    const header = [
      `《${paperTitle}》`,
      [paper.year || "年份未知", paper.venue].filter(Boolean).join(" · "),
      paper.authors.length ? `作者:${paper.authors.map((a) => a.name).join("、")}` : "",
      `被引 ${paper.citations.toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("\n");

    chunks.push({
      chunkId: `${paper.id}:meta`,
      paperId: paper.id,
      paperIds: [paper.id],
      title: paperTitle,
      section: "title",
      year: paper.year || undefined,
      text: header,
      quote: header,
      // 标题是强信号:重复一遍,让词面检索更偏向"问到的这篇论文"
      tokens: [
        ...tokenizeForSearch(paperTitle),
        ...tokenizeForSearch(paperTitle),
        ...tokenizeForSearch(header),
      ],
    });

    const abstract = formatPaperText(paper.abstract ?? "");
    if (!abstract) continue;
    for (const part of chunkText(abstract, { target: 360, overlap: 80, minTail: 100 })) {
      chunks.push({
        chunkId: `${paper.id}:abstract:${part.index}`,
        paperId: paper.id,
        paperIds: [paper.id],
        title: paperTitle,
        section: "abstract",
        year: paper.year || undefined,
        text: part.text,
        quote: part.text.slice(0, 220),
        tokens: tokenizeForSearch(`${paperTitle} ${part.text}`),
      });
    }
  }

  // 只收语义关系:引用边是骨架,逐条写进语料只会稀释检索
  for (const edge of payload.graph.edges) {
    if (edge.layer !== "semantic") continue;
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;

    const label = edgeLabelForKind(edge.kind, payload.presets);
    const source = relationSource(edge, a, b, label);
    chunks.push({
      ...source,
      tokens: tokenizeForSearch(
        `${label} ${edge.kind} ${formatPaperText(a.title)} ${formatPaperText(b.title)} ${source.text}`,
      ),
    });
  }

  return { starfieldId: payload.starfield.id, chunks };
}
