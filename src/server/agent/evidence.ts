/**
 * 工具结果 → 能进回答的证据。
 *
 * 工具返回的是 JSON,回答模型要的是带编号的段落。这里做三件事:
 *   1. 星空内的结果转成和 RAG 检索同构的块(chunkId 一致,方便去重);
 *   2. 外部结果(OpenAlex)单独成段,明确标注「未并入本片星空」,
 *      不让它们混进 [n] 角标 —— 角标必须能点回一篇真实的论文;
 *   3. 同一篇摘要、同一条关系重复出现时只留一份。
 */

import type { StarfieldPayload } from "@/types/api";
import type { PaperNode } from "@/types/kg";

import { edgeLabelForKind } from "@/lib/graph/edge-kinds";

import type { RagSource } from "../rag/corpus";
import { relationSource } from "../rag/corpus";
import type { RetrievedSource } from "../rag/retrieve";
import type { AgentToolName } from "./plan";

interface RelationBrief {
  source: string;
  target: string;
  relationId: string;
  relation: string;
  confidence: number;
  rationale?: string;
  evidence?: Array<{ kind: string; quote?: string; note?: string }>;
}

interface SearchResult {
  hits?: Array<{
    chunkId: string;
    paperId: string;
    title: string;
    section: "title" | "abstract" | "relation";
    year?: number;
    score?: number;
    quote: string;
  }>;
}

interface RelationResult {
  found?: boolean;
  relations?: RelationBrief[];
}

interface ContextResult {
  paper?: { id: string };
  abstract?: string;
  semanticRelations?: RelationBrief[];
}

interface ExternalWork {
  title: string;
  year?: number;
  citations?: number;
  venue?: string;
  doi?: string;
  relation?: string;
}

interface ExpandResult {
  neighbors?: ExternalWork[];
}

interface SearchPapersResult {
  results?: ExternalWork[];
}

export interface ToolEvidence {
  sources: RagSource[];
  external: string[];
}

const EMPTY: ToolEvidence = { sources: [], external: [] };

function paperMap(payload: StarfieldPayload): Map<string, PaperNode> {
  return new Map(
    payload.graph.nodes
      .filter((node): node is PaperNode => node.kind === "paper")
      .map((node) => [node.id, node]),
  );
}

/** 工具给的是关系摘要,这里回到载荷里找同一条边,复用 corpus 的块构造。 */
function relationSources(
  payload: StarfieldPayload,
  relations: RelationBrief[] | undefined,
): RagSource[] {
  if (!relations?.length) return [];
  const papers = paperMap(payload);
  const out: RagSource[] = [];
  for (const brief of relations) {
    const a = papers.get(brief.source);
    const b = papers.get(brief.target);
    if (!a || !b) continue;
    const edge = payload.graph.edges.find(
      (item) =>
        item.layer === "semantic" &&
        item.kind === brief.relationId &&
        ((item.source === a.id && item.target === b.id) ||
          (item.source === b.id && item.target === a.id)),
    );
    if (!edge) continue;
    out.push(relationSource(edge, a, b, edgeLabelForKind(edge.kind, payload.presets)));
  }
  return out;
}

function externalLine(work: ExternalWork): string {
  const meta = [
    `《${work.title}》`,
    work.year ? String(work.year) : "",
    work.venue ?? "",
    typeof work.citations === "number" ? `被引 ${work.citations.toLocaleString()}` : "",
    work.relation ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `${meta}(OpenAlex 结果,未并入本片星空)`;
}

export function evidenceFromTool(
  payload: StarfieldPayload,
  tool: AgentToolName,
  result: unknown,
): ToolEvidence {
  if (!result || typeof result !== "object") return EMPTY;

  if (tool === "search_starfield") {
    const hits = (result as SearchResult).hits ?? [];
    return {
      sources: hits
        .filter((hit) => hit.chunkId && hit.paperId && hit.quote)
        .map((hit) => ({
          chunkId: hit.chunkId,
          paperId: hit.paperId,
          paperIds: [hit.paperId],
          title: hit.title,
          section: hit.section,
          year: hit.year,
          text: hit.quote,
          quote: hit.quote,
        })),
      external: [],
    };
  }

  if (tool === "find_relation_evidence") {
    return { sources: relationSources(payload, (result as RelationResult).relations), external: [] };
  }

  if (tool === "get_paper_context") {
    const data = result as ContextResult;
    const id = data.paper?.id;
    const paper = id ? paperMap(payload).get(id) : undefined;
    const sources: RagSource[] = [];
    if (paper?.abstract && data.abstract) {
      sources.push({
        chunkId: `agent:context:${paper.id}:abstract`,
        paperId: paper.id,
        paperIds: [paper.id],
        title: paper.title,
        section: "abstract",
        year: paper.year || undefined,
        text: data.abstract,
        quote: data.abstract.slice(0, 220),
      });
    }
    sources.push(...relationSources(payload, data.semanticRelations));
    return { sources, external: [] };
  }

  if (tool === "expand_citations") {
    const neighbors = (result as ExpandResult).neighbors ?? [];
    return {
      sources: [],
      external: neighbors.filter((work) => work.title).slice(0, 8).map(externalLine),
    };
  }

  if (tool === "search_papers") {
    const results = (result as SearchPapersResult).results ?? [];
    return {
      sources: [],
      external: results.filter((work) => work.title).slice(0, 8).map(externalLine),
    };
  }

  return EMPTY;
}

/**
 * 合并证据:检索到的在前,工具新找到的在后。
 *
 * 上限 12 块:再多会挤占回答模型的上下文,也会让 [n] 角标密到没法读。
 * 同一 chunkId 只留第一次出现的那份 —— 工具常常会重复检出检索已经拿到的东西。
 */
export function mergeSources(
  base: RetrievedSource[],
  additions: RagSource[],
  max = 12,
): RetrievedSource[] {
  const out = [...base];
  const seen = new Set(base.map((item) => item.chunkId));
  const seenSections = new Set(
    base
      .filter((item) => item.section !== "relation")
      .map((item) => `${item.paperId}|${item.section}`),
  );
  for (const item of additions) {
    if (seen.has(item.chunkId)) continue;
    // 工具返回的上下文摘要可能和检索块内容相同但 chunkId 不同;
    // 同一篇的同一章节只保留一份,避免回答里出现两个指向同一段原文的角标。
    const sectionKey = `${item.paperId}|${item.section}`;
    if (item.section !== "relation" && seenSections.has(sectionKey)) continue;
    seen.add(item.chunkId);
    seenSections.add(sectionKey);
    out.push({ ...item, score: 0.5 });
    if (out.length >= max) break;
  }
  return out;
}

export function mergeExternal(groups: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of groups) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= 8) break;
  }
  return out;
}
