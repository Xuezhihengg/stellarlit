/**
 * MCP 工具集 —— 把星空的能力交给「自己决定查什么」的调用方。
 *
 * 这里的每个工具都是**只读**的:读存档、查 OpenAlex、检索语料、查两篇之间的
 * 已判定关系。改图(并入种子、重跑判定)不在这里 —— 那些要花模型调用和钱,
 * 必须由用户确认,不能由一个自己乱逛的 agent 决定。
 *
 * 工具描述是写给模型看的说明书:说清什么时候该用、返回什么、边界在哪。
 * 描述写不好,模型就会放着 search_starfield 不用,退化成瞎猜。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatPaperText } from "@/lib/format";
import { edgeLabelForKind, edgeKindOf } from "@/lib/graph/edge-kinds";
import { edgeKindLabel } from "@/lib/graph/edge-labels";
import type { GraphEdge, PaperNode } from "@/types/kg";
import type { SeedCandidate } from "@/types/starfield";

import { retrieveSourcesDetailed } from "../rag/retrieve";
import { resolveSeed } from "../seed/resolve";
import { resolveSourceContext } from "../source-settings";
import { loadStarfield, listStarfields } from "../starfield/store";
import { getCitingWorks, getWorkById, getWorksByIds, searchWorks } from "../sources/openalex";
import type { OaWork } from "../sources/openalex";

interface ToolPayload {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 工具的返回值一律是紧凑 JSON:模型读得懂,也省 token。 */
const ok = (data: unknown): ToolPayload => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const fail = (message: string): ToolPayload => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const clip = (text: string | undefined, max: number): string | undefined => {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const shortId = (id: string): string =>
  id.replace(/^paper:/, "").replace(/^https?:\/\/openalex\.org\//, "");

const nodeId = (id: string): string => (id.startsWith("paper:") ? id : `paper:${shortId(id)}`);

const workBrief = (work: OaWork) => ({
  id: nodeId(work.id),
  title: formatPaperText(work.title),
  year: work.year,
  citations: work.citedByCount,
  venue: work.venue,
  doi: work.doi,
  authors: work.authors.slice(0, 3).map((a) => a.name),
});

const candidateBrief = (candidate: SeedCandidate) => ({
  id: candidate.id,
  title: formatPaperText(candidate.title),
  year: candidate.year,
  citations: candidate.citations,
  venue: candidate.venue,
  authors: candidate.authors.slice(0, 3),
});

const paperBrief = (paper: PaperNode) => ({
  id: paper.id,
  title: formatPaperText(paper.title),
  year: paper.year,
  citations: paper.citations,
  venue: paper.venue,
  doi: paper.doi,
  arxivId: paper.arxivId,
  hasAbstract: Boolean(paper.abstract),
});

/** 把一条边压成「谁 → 谁、什么关系、凭什么」。 */
function edgeBrief(edge: GraphEdge, payload: Awaited<ReturnType<typeof loadStarfield>>) {
  const presets = payload?.presets ?? [];
  const preset = presets.find(
    (item) => edgeKindOf(item.id) === edge.kind,
  );
  return {
    source: edge.source,
    target: edge.target,
    relation: preset?.label ?? edgeKindLabel(edge.kind),
    relationId: edge.kind,
    directed: edge.directed,
    confidence: Number(edge.confidence.toFixed(2)),
    rationale: clip(edge.rationale, 400),
    evidence: edge.evidence.slice(0, 3).map((item) => {
      if (item.kind === "span") {
        return {
          kind: "span",
          paperId: item.paperId,
          section: item.section,
          quote: clip(item.quote, 260),
        };
      }
      if (item.kind === "citation") {
        return { kind: "citation", note: item.note ?? `${item.paperId} 引用 ${item.cites}` };
      }
      return { kind: item.kind };
    }),
  };
}

export function registerStarfieldTools(server: McpServer, ownerId: string): void {
  // 不再回退到「最早注册的账号」:站内 Agent 用当前会话,外部客户端用个人令牌解析出的 owner。
  const owner = async (): Promise<string> => ownerId;

  server.registerTool(
    "list_starfields",
    {
      title: "列出已保存的星空",
      description:
        "列出本机所有调研存档。返回每片星空的 id、名称、种子论文、论文数与边数、更新时间。" +
        "调用其它星空相关工具前,先用它拿到 starfieldId。没有参数。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = await listStarfields(await owner());
      if (!list.length) {
        return ok({
          starfields: [],
          hint: "本机还没有星空。用 resolve_seed 解析一篇种子论文,由用户确认后再构建。",
        });
      }
      return ok({
        starfields: list.map((item) => ({
          id: item.id,
          name: item.name,
          seeds: item.seedTitles,
          papers: item.stats.papers,
          edges: item.stats.edges,
          updatedAt: item.updatedAt,
        })),
      });
    },
  );

  server.registerTool(
    "get_starfield",
    {
      title: "读取一片星空的结构",
      description:
        "返回某片星空的种子、规模统计、关系类型分布,以及按被引量排序的论文清单(默认 40 条)。" +
        "想快速了解一片星空讲了什么,先调它;需要全文摘要时再对具体论文调 get_paper_context。",
      inputSchema: {
        starfieldId: z.string().min(1).describe("星空 id,来自 list_starfields"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("返回多少篇论文,默认 40"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ starfieldId, limit }) => {
      const payload = await loadStarfield(starfieldId, await owner());
      if (!payload) return fail(`没有找到星空 ${starfieldId}。先调用 list_starfields 确认 id。`);

      const papers = payload.graph.nodes
        .filter((node): node is PaperNode => node.kind === "paper")
        .sort((a, b) => b.citations - a.citations)
        .slice(0, limit ?? 40)
        .map(paperBrief);

      const relationCounts: Record<string, number> = {};
      for (const edge of payload.graph.edges) {
        if (edge.layer !== "semantic") continue;
        const label = edgeLabelForKind(edge.kind, payload.presets);
        relationCounts[label] = (relationCounts[label] ?? 0) + 1;
      }

      return ok({
        id: payload.starfield.id,
        name: payload.starfield.name,
        seeds: payload.starfield.seeds.map((seed) => ({ query: seed.query, paperId: seed.paperId })),
        stats: payload.starfield.stats,
        relationCounts,
        relationsAvailable: payload.presets.map((preset) => ({
          id: preset.id,
          label: preset.label,
          description: preset.description,
        })),
        papers,
        truncated: payload.starfield.stats.papers > papers.length,
      });
    },
  );

  server.registerTool(
    "get_paper",
    {
      title: "按 id / DOI / 标题查一篇论文",
      description:
        "在 OpenAlex 里查单篇论文的元数据与摘要(摘要截断到 900 字)。" +
        "支持 OpenAlex id(W123)、DOI、arXiv id 或标题。查完想扩展邻域时用 expand_citations。",
      inputSchema: {
        paperId: z.string().min(2).describe("OpenAlex id、DOI、arXiv id 或论文标题"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ paperId }) => {
      const source = await resolveSourceContext(await owner());
      let candidates;
      try {
        candidates = await resolveSeed(paperId, new Set(), source);
      } catch {
        return fail("查询 OpenAlex 失败,可能是网络问题。稍后重试。");
      }
      const best = candidates[0];
      if (!best) return fail(`没有找到与「${paperId}」匹配的论文。换一个标题或直接用 DOI。`);

      const work = await getWorkById(shortId(best.id), source).catch(() => null);
      return ok({
        ...(work ? workBrief(work) : candidateBrief(best)),
        abstract: work?.abstract ? clip(formatPaperText(work.abstract), 900) : undefined,
        referencedCount: work?.referencedWorksCount ?? work?.referencedWorks.length,
        matchReason: best.reason,
        confidence: Number(best.confidence.toFixed(2)),
      });
    },
  );

  server.registerTool(
    "expand_citations",
    {
      title: "展开一篇论文的引文邻域",
      description:
        "取一篇论文的参考文献(backward)和/或引用它的工作(forward),按被引量排序。" +
        "用来回答「这篇之前有什么基础」「后来谁沿用了它」,也用来判断某个方向是否值得继续挖。",
      inputSchema: {
        paperId: z.string().min(2).describe("OpenAlex id(可带 paper: 前缀)或 DOI"),
        direction: z
          .enum(["backward", "forward", "both"])
          .optional()
          .describe("backward=参考文献,forward=引用它的工作,默认 both"),
        limit: z.number().int().min(1).max(50).optional().describe("每个方向最多几条,默认 12"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ paperId, direction = "both", limit = 12 }) => {
      const source = await resolveSourceContext(await owner());
      const id = shortId(paperId);
      const work = await getWorkById(id, source).catch(() => null);
      if (!work) return fail(`OpenAlex 里没有 ${paperId}。先用 get_paper 确认 id。`);

      const neighbors: Array<Record<string, unknown>> = [];
      try {
        if (direction !== "forward" && work.referencedWorks.length) {
          const refs = await getWorksByIds(work.referencedWorks.slice(0, limit), source);
          neighbors.push(...refs.map((ref) => ({ ...workBrief(ref), relation: "参考文献" })));
        }
        if (direction !== "backward") {
          const citing = await getCitingWorks(work.id, limit, source);
          neighbors.push(...citing.map((item) => ({ ...workBrief(item), relation: "引用本文" })));
        }
      } catch {
        return fail("拉取引文邻域失败,可能是网络问题或触发了 OpenAlex 限流。");
      }

      neighbors.sort((a, b) => Number(b.citations ?? 0) - Number(a.citations ?? 0));
      return ok({
        paper: workBrief(work),
        neighborCount: neighbors.length,
        neighbors: neighbors.slice(0, limit * 2),
      });
    },
  );

  server.registerTool(
    "search_starfield",
    {
      title: "在星空语料里检索原文",
      description:
        "对一片星空做混合检索(BM25 + 向量 RRF + 图关系扩展 + 意图重排),返回最相关的证据块:chunkId、论文、章节、原文摘录。" +
        "回答「这片星空里怎么说」这类问题时用它 —— 拿到 chunkId 才能给出可核对的引用。",
      inputSchema: {
        starfieldId: z.string().min(1),
        query: z.string().min(2).max(200).describe("检索词或问题"),
        limit: z.number().int().min(1).max(20).optional().describe("返回几块,默认 6"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ starfieldId, query, limit }) => {
      const payload = await loadStarfield(starfieldId, await owner());
      if (!payload) return fail(`没有找到星空 ${starfieldId}。`);

      const { sources: hits, diagnostics } = await retrieveSourcesDetailed(
        payload,
        query,
        limit ?? 6,
        { ownerId: await owner() },
      );
      if (!hits.length) {
        return ok({
          query,
          hits: [],
          hint: "这片星空里没有匹配的段落。可以换关键词,或用 expand_citations 去外部找。",
        });
      }
      return ok({
        query,
        retrieval: {
          mode: diagnostics.mode,
          coverage: diagnostics.coverage,
          intent: diagnostics.intent,
          graphRelations: diagnostics.graphRelations,
        },
        hits: hits.map((hit, index) => ({
          n: index + 1,
          chunkId: hit.chunkId,
          paperId: hit.paperId,
          title: hit.title,
          section: hit.section,
          year: hit.year,
          score: Number(hit.score.toFixed(2)),
          quote: clip(hit.quote, 500),
        })),
      });
    },
  );

  server.registerTool(
    "find_relation_evidence",
    {
      title: "查两篇论文之间的关系与证据",
      description:
        "在某片星空里查两篇论文之间**已经判定过**的关系:关系类型、置信度、模型理由、原文证据片段。" +
        "同一对论文可能同时存在多条语义关系(例如既是基线、又方法相异),relations 会全部列出,按置信度排序。" +
        "这是本项目区别于普通检索的地方 —— 关系是带证据核验过的,可以直接引用。" +
        "如果两篇属于不同星空或尚未判定,会返回 found=false,而不是猜一个。",
      inputSchema: {
        starfieldId: z.string().min(1),
        paperA: z.string().min(2).describe("第一篇的 id,可带 paper: 前缀"),
        paperB: z.string().min(2).describe("第二篇的 id,可带 paper: 前缀"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ starfieldId, paperA, paperB }) => {
      const payload = await loadStarfield(starfieldId, await owner());
      if (!payload) return fail(`没有找到星空 ${starfieldId}。`);

      const a = nodeId(paperA);
      const b = nodeId(paperB);
      const matched = payload.graph.edges.filter(
        (item) =>
          (item.source === a && item.target === b) || (item.source === b && item.target === a),
      );

      if (!matched.length) {
        return ok({
          found: false,
          hint: "这两篇之间没有已判定的关系边。可能它们不在同一片星空,或候选没通过硬约束。",
          bothInStarfield:
            payload.graph.nodes.some((node) => node.id === a) &&
            payload.graph.nodes.some((node) => node.id === b),
        });
      }

      // 语义关系才是「判定过的结论」;结构边(引用)只是事实,单独放 structural。
      const relations = matched
        .filter((item) => item.layer === "semantic")
        .sort((left, right) => right.confidence - left.confidence)
        .map((item) => edgeBrief(item, payload));
      const structural = matched
        .filter((item) => item.layer !== "semantic")
        .map((item) => ({ relation: edgeKindLabel(item.kind), directed: item.directed }));

      return ok({
        found: true,
        relations,
        structural,
        hint:
          relations.length === 0
            ? "这两篇之间只有引用关系,还没有语义判定。"
            : undefined,
      });
    },
  );

  server.registerTool(
    "get_paper_context",
    {
      title: "读一篇论文在星空里的上下文",
      description:
        "返回这篇论文的摘要、它在这片星空里的所有关系边(谁引用它、它属于哪个基线组、和谁方法相异)," +
        "以及每条边的证据摘要。想解释「这篇为什么长在这里」时用它。",
      inputSchema: {
        starfieldId: z.string().min(1),
        paperId: z.string().min(2),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ starfieldId, paperId }) => {
      const payload = await loadStarfield(starfieldId, await owner());
      if (!payload) return fail(`没有找到星空 ${starfieldId}。`);

      const id = nodeId(paperId);
      const node = payload.graph.nodes.find((item) => item.id === id);
      if (!node || node.kind !== "paper") {
        return fail(`${paperId} 不在这片星空里。先用 search_starfield 或 get_starfield 确认。`);
      }

      const edges = payload.graph.edges.filter(
        (edge) => edge.source === id || edge.target === id,
      );
      const semantic = edges.filter((edge) => edge.layer === "semantic");
      const structural = edges.filter((edge) => edge.layer === "structural");

      return ok({
        paper: paperBrief(node),
        abstract: node.abstract ? clip(formatPaperText(node.abstract), 900) : undefined,
        semanticRelations: semantic.map((edge) => edgeBrief(edge, payload)),
        structuralCounts: {
          cites: structural.filter((edge) => edge.kind === "CITES").length,
          citedBy: structural.filter((edge) => edge.kind === "CITES" && edge.target === id).length,
        },
        totalEdges: edges.length,
      });
    },
  );

  server.registerTool(
    "resolve_seed",
    {
      title: "解析一篇新论文(只返回候选)",
      description:
        "把用户输入(标题 / DOI / arXiv id / OpenAlex id)解析成候选论文,按置信度排序。" +
        "**不会**改动任何星空 —— 是否并入要由用户确认。适合回答「这篇值不值得加进星图」。",
      inputSchema: {
        query: z.string().min(2).describe("标题、DOI、arXiv id 或 OpenAlex id"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      const source = await resolveSourceContext(await owner());
      try {
        const candidates = await resolveSeed(query, new Set(), source);
        if (!candidates.length) {
          return ok({ query, candidates: [], hint: "没有匹配。换更完整的标题,或改用 DOI。" });
        }
        return ok({
          query,
          candidates: candidates.slice(0, 5).map((item) => ({
            id: item.id,
            title: formatPaperText(item.title),
            year: item.year,
            venue: item.venue,
            citations: item.citations,
            confidence: Number(item.confidence.toFixed(2)),
            reason: item.reason,
          })),
        });
      } catch {
        return fail("解析失败:OpenAlex/arXiv 暂时不可达,稍后重试。");
      }
    },
  );

  server.registerTool(
    "search_papers",
    {
      title: "在 OpenAlex 里检索论文",
      description:
        "按主题关键词检索文献,可按年份过滤,按被引量排序。用于星空里还没有、但回答需要的内容。" +
        "返回的是外部结果,不是本项目的已核验关系 —— 引用它时要说清来源。",
      inputSchema: {
        query: z.string().min(2).max(200).describe("主题关键词,英文效果更好"),
        fromYear: z.number().int().min(1900).max(2100).optional(),
        toYear: z.number().int().min(1900).max(2100).optional(),
        limit: z.number().int().min(1).max(25).optional().describe("返回几条,默认 8"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, fromYear, toYear, limit = 8 }) => {
      const source = await resolveSourceContext(await owner());
      try {
        const works = await searchWorks(
          { query, fromYear, toYear, limit: limit * 3 },
          source,
        );
        const picked = works
          .sort((a, b) => b.citedByCount - a.citedByCount)
          .slice(0, limit)
          .map(workBrief);
        return ok({ query, fromYear, toYear, results: picked });
      } catch {
        return fail("检索 OpenAlex 失败,可能是网络问题或限流。");
      }
    },
  );
}
