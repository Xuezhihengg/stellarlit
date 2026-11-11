/**
 * 种子解析 —— 用户给什么都要接得住,但**绝不替用户猜**。
 *
 * 设计决定:永远返回候选列表,由用户在界面上确认。原因是实测数据源不可信:
 * OpenAlex 把 arXiv 的自动 DOI 映射错了(BERT 指向一篇毫不相关的论文),
 * 标题检索的首位也可能是合并坏了的重复记录。
 * 与其猜错,不如把选择权交回去 —— 这同时也是一次天然的人在设计回路里。
 */

import type { SeedCandidate } from "@/types/starfield";

import { getArxivEntries, searchArxiv } from "../sources/arxiv";
import { getWorkById, getWorkByDoi, searchWorksByTitle, type OaWork } from "../sources/openalex";

export type SeedKind = "arxiv" | "doi" | "openalex" | "title";

export interface SeedQuery {
  kind: SeedKind;
  value: string;
}

/** 归一化 arXiv ID:去掉版本号与 URL 包装。 */
export function normalizeArxivId(s: string): string {
  const m = /(\d{4}\.\d{4,5})(v\d+)?/.exec(s);
  return m?.[1] ?? s.trim();
}

/**
 * 判断用户输入的是什么。
 *
 * 关键的一条规则:`10.48550/arxiv.*` 这批自动生成的 DOI 一律当成 arXiv ID,
 * 绕开 OpenAlex 的错误映射,直接走 arXiv 官方 API。
 */
export function parseSeedQuery(raw: string): SeedQuery {
  const s = raw.trim();

  const arxivUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i.exec(s);
  if (arxivUrl?.[1]) return { kind: "arxiv", value: normalizeArxivId(arxivUrl[1]) };

  if (/^arxiv:/i.test(s)) return { kind: "arxiv", value: normalizeArxivId(s.replace(/^arxiv:/i, "")) };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return { kind: "arxiv", value: normalizeArxivId(s) };
  if (/^W\d+$/.test(s)) return { kind: "openalex", value: s };

  const doiMatch = /(10\.\d{4,9}\/[^\s]+)/.exec(s);
  if (doiMatch?.[1]) {
    const doi = doiMatch[1].replace(/[.,;]$/, "");
    const asArxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
    if (asArxiv?.[1]) return { kind: "arxiv", value: normalizeArxivId(asArxiv[1]) };
    return { kind: "doi", value: doi };
  }

  return { kind: "title", value: s };
}

/** 归一化:小写,只留字母数字与中日韩字符。 */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Dice 系数(字符二元组)。
 *
 * 比编辑距离更抗语序差异:「Attention Is All You Need」与
 * 「Attention is all you need」这种大小写与标点差异要拿满分,
 * 而「Attention is not all you need」这种一字之差要能降下来。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  let total = 0;
  for (const [g, c] of gx) {
    total += c;
    const d = gy.get(g);
    if (d) inter += Math.min(c, d);
  }
  for (const c of gy.values()) total += c;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** 论文节点的 ID 规则,必须与图谱模型一致。 */
export function paperNodeId(openalexId: string): string {
  return `paper:${openalexId}`;
}

function toCandidate(
  w: OaWork,
  confidence: number,
  reason: string,
  known: ReadonlySet<string>,
  arxivId?: string,
): SeedCandidate {
  const id = paperNodeId(w.id);
  return {
    id,
    title: w.title,
    year: w.year,
    venue: w.venue,
    citations: w.citedByCount,
    authors: w.authors.slice(0, 4).map((a) => a.name),
    confidence,
    reason: arxivId ? `${reason} · arXiv:${arxivId}` : reason,
    alreadyInStarfield: known.has(id),
  };
}

/**
 * 在 OpenAlex 里按「标题 + 年份」找回一篇工作的正主。
 *
 * 年份差一年以内不罚分:预印本与正式发表常常跨年,
 * 而这一点恰恰是「标题完全一致但年份差得远 = 可能是合并坏了的记录」的信号。
 */
async function matchByTitle(
  title: string,
  year: number | undefined,
  known: ReadonlySet<string>,
): Promise<SeedCandidate[]> {
  let works;
  try {
    works = await searchWorksByTitle(title, 8);
  } catch {
    /**
     * OpenAlex 不可用时退回 arXiv。
     *
     * 退回来的候选是**同一个坐标系之外**的:arXiv 给不出被引量,
     * 也没有引文邻域。所以它只解决"能不能开始",不解决"图上有什么" ——
     * 建图阶段会再走一次源选择。这里如实标注,不假装数据和主源一样。
     */
    return (await searchArxiv(title, 5)).map((e) => ({
      id: `paper:ARXIV:${e.arxivId}`,
      title: e.title,
      year: e.year,
      venue: e.primaryCategory || undefined,
      citations: 0,
      authors: e.authors.slice(0, 4),
      confidence: titleSimilarity(title, e.title),
      reason: "arXiv 匹配",
      alreadyInStarfield: known.has(`paper:ARXIV:${e.arxivId}`),
    }));
  }
  return works
    .map((w) => {
      const sim = titleSimilarity(title, w.title);
      const yearOk = !year || !w.year ? 0.5 : Math.abs(w.year - year) <= 1 ? 1 : 0.35;
      const confidence = Math.max(0, Math.min(1, sim * 0.85 + yearOk * 0.15));
      const yearNote = year && w.year ? `,年份 ${w.year}(期望 ${year})` : "";
      return toCandidate(w, confidence, `标题相似度 ${(sim * 100).toFixed(0)}%${yearNote}`, known);
    })
    .sort((a, b) => b.confidence - a.confidence || b.citations - a.citations)
    .slice(0, 5);
}

/**
 * 解析种子,返回候选(按置信度降序)。
 *
 * arXiv 入口的做法:先用 arXiv 拿到**权威标题**,再拿这个标题去 OpenAlex 找
 * 对应的引文记录 —— 因为引文邻域只有在 OpenAlex 里才有。
 */
export async function resolveSeed(
  raw: string,
  known: ReadonlySet<string> = new Set(),
): Promise<SeedCandidate[]> {
  const q = parseSeedQuery(raw);

  if (q.kind === "openalex") {
    const w = await getWorkById(q.value);
    return w ? [toCandidate(w, 1, "OpenAlex ID 精确匹配", known)] : [];
  }

  if (q.kind === "doi") {
    const w = await getWorkByDoi(q.value);
    return w ? [toCandidate(w, 1, "DOI 精确匹配", known)] : [];
  }

  if (q.kind === "arxiv") {
    const [entry] = await getArxivEntries([q.value]);
    if (!entry) return [];
    const candidates = await matchByTitle(entry.title, entry.year, known);
    // 把 arXiv ID 标到最佳匹配上,便于界面显示与后续取全文
    return candidates.map((c, i) => (i === 0 ? { ...c, reason: `${c.reason} · arXiv:${entry.arxivId}` } : c));
  }

  return matchByTitle(q.value, undefined, known);
}
