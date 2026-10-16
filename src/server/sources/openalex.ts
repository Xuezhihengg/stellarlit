/**
 * OpenAlex 客户端 —— 免费、免密钥、覆盖全学科的引文图。
 *
 * 提供三样我们需要的东西:
 *   1. 一篇工作的元数据 + abstract + referenced_works(向后引用 = 它引用了谁)
 *   2. `cites:<id>` 过滤(向前引用 = 谁引用了它)—— 这是「星图之所以是星图」的关键
 *   3. topics 的 field / subfield / topic 三级分类,当作零成本的语义标签
 */

import { serverConfig } from "../config";
import { fetchJson } from "../http";

const OA = "https://api.openalex.org";

const SELECT = [
  "id",
  "display_name",
  "publication_year",
  "cited_by_count",
  "referenced_works",
  "referenced_works_count",
  "topics",
  "doi",
  "primary_location",
  "authorships",
  "type",
  "abstract_inverted_index",
].join(",");

export interface OaFieldTag {
  level: "field" | "subfield" | "topic";
  id: string;
  name: string;
  score?: number;
}

export interface OaAuthor {
  name: string;
  id?: string;
  institution?: string;
}

export interface OaWork {
  /** 短 ID,例如 W2626778328 */
  id: string;
  title: string;
  abstract?: string;
  year: number;
  citedByCount: number;
  /** 短 ID 列表 */
  referencedWorks: string[];
  /** 该记录声称的参考文献条数(与 referencedWorks.length 可能不一致) */
  referencedWorksCount: number;
  fields: OaFieldTag[];
  doi?: string;
  venue?: string;
  authors: OaAuthor[];
  /** OpenAlex 作品类型(article / review / preprint / conference-paper …) */
  type?: string;
  isOpenAccess?: boolean;
}

interface RawWork {
  id?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  referenced_works?: string[];
  referenced_works_count?: number;
  topics?: Array<{
    id?: string;
    display_name?: string;
    score?: number;
    subfield?: { id?: string; display_name?: string };
    field?: { id?: string; display_name?: string };
  }>;
  doi?: string;
  primary_location?: {
    source?: { display_name?: string } | null;
    is_oa?: boolean;
  } | null;
  authorships?: Array<{
    author?: { id?: string; display_name?: string };
    institutions?: Array<{ display_name?: string }>;
  }>;
  type?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
}

const short = (id: string): string => id.split("/").pop() ?? id;

/**
 * 把 OpenAlex 的倒排摘要还原成正文。
 *
 * 上游为了省流量返回的是 `{词: [位置…]}`,而不是字符串。还原必须按位置排序,
 * 否则读出来的是乱序的词。位置在多个词之间可能重复(同一位置有多个词),
 * 因此用「位置 → 词列表」聚合后再铺平。
 */
function rebuildAbstract(inverted: Record<string, number[]> | null | undefined): string | undefined {
  if (!inverted) return undefined;
  const byPos: string[] = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) {
      const bucket = byPos[p];
      byPos[p] = bucket ? `${bucket} ${word}` : word;
    }
  }
  const text = byPos.filter(Boolean).join(" ").trim();
  return text || undefined;
}

function toWork(r: RawWork): OaWork {
  const fields: OaFieldTag[] = [];
  for (const t of r.topics ?? []) {
    if (t.id && t.display_name) {
      fields.push({ level: "topic", id: short(t.id), name: t.display_name, score: t.score });
    }
    if (t.subfield?.id && t.subfield.display_name) {
      fields.push({ level: "subfield", id: short(t.subfield.id), name: t.subfield.display_name });
    }
    if (t.field?.id && t.field.display_name) {
      fields.push({ level: "field", id: short(t.field.id), name: t.field.display_name });
    }
  }

  return {
    id: short(r.id ?? ""),
    title: r.display_name ?? "",
    abstract: rebuildAbstract(r.abstract_inverted_index),
    year: r.publication_year ?? 0,
    citedByCount: r.cited_by_count ?? 0,
    referencedWorks: (r.referenced_works ?? []).map(short),
    referencedWorksCount: r.referenced_works_count ?? (r.referenced_works ?? []).length,
    fields,
    doi: r.doi ?? undefined,
    venue: r.primary_location?.source?.display_name ?? undefined,
    authors: (r.authorships ?? [])
      .map((a) => ({
        name: a.author?.display_name ?? "",
        id: a.author?.id ? short(a.author.id) : undefined,
        institution: a.institutions?.[0]?.display_name,
      }))
      .filter((a) => a.name),
    type: r.type ?? undefined,
    isOpenAccess: r.primary_location?.is_oa,
  };
}

/** 过滤值里的逗号/冒号会破坏 OpenAlex 的查询语法,必须清掉。 */
const clean = (s: string): string => s.replace(/[,:|]/g, " ").replace(/\s+/g, " ").trim();

const mailto = () => `mailto=${encodeURIComponent(serverConfig.openalexMailto)}`;

export async function getWorkById(id: string): Promise<OaWork | null> {
  const raw = await fetchJson<RawWork>(`${OA}/works/${id}?select=${SELECT}&${mailto()}`);
  return raw.id ? toWork(raw) : null;
}

export async function getWorkByDoi(doi: string): Promise<OaWork | null> {
  try {
    const raw = await fetchJson<RawWork>(
      `${OA}/works/doi:${encodeURIComponent(doi)}?select=${SELECT}&${mailto()}`,
    );
    return raw.id ? toWork(raw) : null;
  } catch {
    return null; // 404 是正常结果:该 DOI 不在 OpenAlex 里
  }
}

/**
 * 按标题检索。
 *
 * 注意必须用 `title.search:` 而不是 `search=`:后者是全文相关度,
 * 实测搜 "attention is all you need" 的第一名是一篇讲逻辑与编程的论文。
 */
export async function searchWorksByTitle(title: string, perPage = 8): Promise<OaWork[]> {
  const url =
    `${OA}/works?filter=${encodeURIComponent(`title.search:${clean(title)}`)}` +
    `&sort=cited_by_count:desc&per-page=${perPage}&select=${SELECT}&${mailto()}`;
  const raw = await fetchJson<{ results?: RawWork[] }>(url);
  return (raw.results ?? []).map(toWork);
}

/**
 * 按关键词 + 时间窗检索。
 *
 * 用 `title_and_abstract.search` 而不是全文检索:我们关心的是「这篇论文在讲什么」,
 * 而不是「它正文里提过什么词」。
 */
export async function searchWorks(opts: {
  query: string;
  fromYear?: number;
  toYear?: number;
  limit?: number;
}): Promise<OaWork[]> {
  const { query, fromYear, toYear, limit = 60 } = opts;
  const filters = [`title_and_abstract.search:${clean(query)}`];
  if (fromYear) filters.push(`from_publication_date:${fromYear}-01-01`);
  if (toYear) filters.push(`to_publication_date:${toYear}-12-31`);
  const url =
    `${OA}/works?filter=${encodeURIComponent(filters.join(","))}` +
    `&sort=cited_by_count:desc&per-page=${Math.min(200, limit)}&select=${SELECT}&${mailto()}`;
  const raw = await fetchJson<{ results?: RawWork[] }>(url);
  return (raw.results ?? []).map(toWork);
}

/**
 * 谁引用了这篇(向前引用),按被引量降序 ——
 * 高被引的引用者才是主干,低被引的引用者往往是噪声。
 */
export async function getCitingWorks(id: string, limit = 200): Promise<OaWork[]> {
  const out: OaWork[] = [];
  let cursor = "*";
  const perPage = Math.min(200, limit);
  while (out.length < limit && cursor) {
    const url =
      `${OA}/works?filter=${encodeURIComponent(`cites:${id}`)}` +
      `&sort=cited_by_count:desc&per-page=${perPage}&cursor=${cursor}` +
      `&select=${SELECT}&${mailto()}`;
    const raw = await fetchJson<{ results?: RawWork[]; meta?: { next_cursor?: string | null } }>(url);
    const batch = (raw.results ?? []).map(toWork);
    out.push(...batch);
    cursor = raw.meta?.next_cursor ?? "";
    if (!batch.length) break;
  }
  return out.slice(0, limit);
}

/** 批量取元数据(OpenAlex 单次 `openalex_id:` 过滤最多 50 个 ID)。 */
export async function getWorksByIds(ids: string[]): Promise<OaWork[]> {
  const out: OaWork[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url =
      `${OA}/works?filter=${encodeURIComponent(`openalex_id:${chunk.join("|")}`)}` +
      `&per-page=${chunk.length}&select=${SELECT}&${mailto()}`;
    const raw = await fetchJson<{ results?: RawWork[] }>(url);
    out.push(...(raw.results ?? []).map(toWork));
  }
  return out;
}
