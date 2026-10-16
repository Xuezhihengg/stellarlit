/**
 * arXiv API 客户端。
 *
 * 为什么种子解析要优先走 arXiv 而不是 OpenAlex 的 DOI:
 * 实测 OpenAlex 对 `10.48550/arxiv.*` 这批自动生成的 DOI 映射是错的 ——
 * BERT(1810.04805)的 DOI 被指到一篇毫不相关的论文。arXiv 自己的 API 才是权威。
 *
 * 注意必须用 https:http 会 301。
 */

import { fetchText } from "../http";

const ARXIV_API = "https://export.arxiv.org/api/query";
/** arXiv 官方要求:每 3 秒最多一次请求。低于这个值的限速会被封。 */
const ARXIV_MIN_INTERVAL = 3000;

export interface ArxivEntry {
  /** 去掉版本号,例如 1706.03762 */
  arxivId: string;
  version: string;
  title: string;
  abstract: string;
  /** YYYY-MM-DD */
  published: string;
  year: number;
  authors: string[];
  primaryCategory: string;
  categories: string[];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decode(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function pick(entry: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry);
  return m?.[1] ? decode(m[1]) : "";
}

function pickAll(entry: string, name: string): string[] {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(entry); m; m = re.exec(entry)) {
    if (m[1]) out.push(decode(m[1]));
  }
  return out;
}

/** 把 Atom 的 `<entry>` 逐个解析成结构化条目。 */
function parseEntries(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const raw = m[1];
    if (!raw) continue;
    const rawId = pick(raw, "id"); // http://arxiv.org/abs/1706.03762v7
    const tail = rawId.split("/abs/").pop() ?? rawId;
    const idMatch = /^(.*?)(v\d+)?$/.exec(tail);
    const published = pick(raw, "published");
    const primary = /primary_category[^>]*term="([^"]+)"/.exec(raw)?.[1] ?? "";

    entries.push({
      arxivId: (idMatch?.[1] ?? tail).trim(),
      version: idMatch?.[2] ?? "",
      title: pick(raw, "title"),
      abstract: pick(raw, "summary"),
      published: published.slice(0, 10),
      year: Number(published.slice(0, 4)) || 0,
      authors: pickAll(raw, "name"),
      primaryCategory: primary,
      categories: pickAll(raw, "term"),
    });
  }
  return entries;
}

/** 按 arXiv ID 批量取元数据(一次请求可带多个 ID)。 */
export async function getArxivEntries(ids: string[]): Promise<ArxivEntry[]> {
  if (!ids.length) return [];
  const url = `${ARXIV_API}?id_list=${encodeURIComponent(ids.join(","))}&max_results=${ids.length}`;
  return parseEntries(await fetchText(url, { minIntervalMs: ARXIV_MIN_INTERVAL }));
}

/** 按标题检索 arXiv。 */
export async function searchArxiv(query: string, max = 6): Promise<ArxivEntry[]> {
  const url =
    `${ARXIV_API}?search_query=${encodeURIComponent(`ti:"${query}"`)}` +
    `&start=0&max_results=${max}&sortBy=relevance`;
  return parseEntries(await fetchText(url, { minIntervalMs: ARXIV_MIN_INTERVAL }));
}
