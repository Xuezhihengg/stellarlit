/**
 * Semantic Scholar 客户端 —— OpenAlex 的备用数据源。
 *
 * 为什么必须有备用:OpenAlex 免费额度是每天 1000 次请求,用尽之后
 * 整个"输入种子 → 长星空"的链路就完全停摆(实测就是如此)。
 * 一个学术工具在额度用完时只能报错,不是工程问题,是设计问题。
 *
 * 输出统一成 `OaWork` 的形状,而不是另立一套类型 ——
 * 下游的建图、社区检测、布局、关系判定一行都不用改。
 * 换数据源的成本,应该止步在适配层。
 *
 * 已知取舍:
 *   - 论文 id 优先用 arXiv id(`ARXIV:xxxx`),因为它跨源稳定;
 *     没有 arXiv 的用 S2 自己的 paperId。**与 OpenAlex 的 W 号不互通** ——
 *     同一篇论文在两个源里可能是两个节点。这只能靠跨源归一化解决,
 *     而那是另一个量级的工程;在降级模式下可以接受。
 *   - S2 不给作者的机构信息,作者列表也比 OpenAlex 粗糙。
 */

import { serverConfig } from "../config";
import { fetchJson } from "../http";
import { formatPaperText } from "@/lib/format";
import type { OaWork } from "./openalex";

const S2 = "https://api.semanticscholar.org/graph/v1";

const PAPER_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "citationCount",
  "externalIds",
  "fieldsOfStudy",
  "authors",
].join(",");

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  citationCount?: number | null;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  fieldsOfStudy?: string[] | null;
  authors?: Array<{ name?: string }> | null;
}

interface S2ListResponse {
  data?: Array<{ paperId?: string } & S2Paper>;
}

/** S2 的引用关系是论文列表,不是 id 列表,所以要单独查一次。 */
interface S2NeighborhoodResponse {
  references?: S2Paper[];
  citations?: S2Paper[];
}

function resolveId(p: S2Paper): string {
  const arxiv = p.externalIds?.ArXiv;
  if (arxiv) return `ARXIV:${arxiv}`;
  return p.paperId ?? "";
}

/**
 * 统一成 OaWork。
 *
 * `citedWorks` / `citedBy` 由调用方补:它们描述的不是这篇论文自己的属性,
 * 而是"它与本次种子之间的关系",放在这里猜不出来。
 */
function toWork(p: S2Paper, citedWorks: string[] = []): OaWork {
  const fields = (p.fieldsOfStudy ?? []).map((f) => ({
    level: "field" as const,
    id: f,
    name: f,
  }));

  return {
    id: resolveId(p),
    title: formatPaperText(p.title ?? ""),
    abstract: p.abstract ? formatPaperText(p.abstract) : undefined,
    year: p.year ?? 0,
    citedByCount: p.citationCount ?? 0,
    referencedWorks: citedWorks,
    referencedWorksCount: citedWorks.length,
    fields,
    doi: p.externalIds?.DOI,
    venue: p.venue ?? undefined,
    authors: (p.authors ?? []).map((a) => ({ name: a.name ?? "" })).filter((a) => a.name),
    type: undefined,
  };
}

const auth = (): Record<string, string> =>
  serverConfig.semanticScholarKey ? { "x-api-key": serverConfig.semanticScholarKey } : {};

async function getJson<T>(url: string): Promise<T> {
  return fetchJson<T>(url, {
    headers: auth(),
    // S2 的匿名额度对突发很敏感:1 秒 1 次是官方给的量级,这里留出余量
    minIntervalMs: 1200,
    retries: 1,
  });
}

export async function s2ByArxiv(arxivId: string): Promise<S2Paper | null> {
  try {
    return await getJson<S2Paper>(`${S2}/${encodeURIComponent(`ARXIV:${arxivId}`)}?fields=${PAPER_FIELDS}`);
  } catch {
    return null;
  }
}

export async function s2Search(title: string, limit = 8): Promise<S2Paper[]> {
  try {
    const url = `${S2}/paper/search?query=${encodeURIComponent(title)}&limit=${limit}&fields=${PAPER_FIELDS}`;
    return (await getJson<S2ListResponse>(url)).data ?? [];
  } catch {
    return [];
  }
}

export interface S2Neighborhood {
  seed: OaWork;
  backward: OaWork[];
  forward: OaWork[];
}

/**
 * 取一篇论文的引文邻域。
 *
 * 这里有个必须补上的动作:S2 返回的引用关系是"列表",而下游建图读的是
 * 每篇论文自己的 `referencedWorks`。如果不把关系写回去,
 * 结构性引用边会**一条都不生成** —— 星图就只剩一堆散点。
 * 所以:
 *   - 种子记下它引用的那些(向后)
 *   - 每个引用者记下"它引用了种子"(向前)
 * 这两条都是构造事实,不是猜测。
 */
export async function s2Neighborhood(paperId: string, pool: number): Promise<S2Neighborhood | null> {
  const id = paperId.startsWith("ARXIV:") ? paperId : `S2:${paperId}`;
  const nested = [
    "paperId",
    "title",
    "abstract",
    "year",
    "venue",
    "citationCount",
    "externalIds",
    "fieldsOfStudy",
  ]
    .map((f) => `references.${f},citations.${f}`)
    .join(",");

  let raw: (S2Paper & S2NeighborhoodResponse) | null = null;
  try {
    raw = await getJson<S2Paper & S2NeighborhoodResponse>(
      `${S2}/paper/${encodeURIComponent(id)}?fields=${PAPER_FIELDS},${nested}&limit=${Math.min(500, pool)}`,
    );
  } catch {
    return null;
  }
  if (!raw?.paperId && !raw?.externalIds?.ArXiv) return null;

  const seedId = resolveId(raw);
  const backwardRefs = raw.references ?? [];
  const forwardRefs = raw.citations ?? [];

  const backward = backwardRefs.map((r) => toWork(r)).filter((w) => w.id);
  const forward = forwardRefs.map((r) => toWork(r, [seedId])).filter((w) => w.id);
  const seed = toWork(raw, backward.map((w) => w.id));

  return { seed, backward, forward };
}
