/**
 * 图像证据索引 —— 把附图拆成可检索、可引用的证据块。
 *
 * 图片不再只是随消息发一次的附件:
 *   1. 视觉模型先做结构化抽取(OCR / 表格 / 图表序列 / 关键数值);
 *   2. 结果按图缓存,重复上传同一张图不会重复调用模型;
 *   3. 每个区域单独成块,按当前问题重排,回答可以引用 [图1-2] 并定位原图。
 *
 * 缓存只保存抽取出的文字与坐标,不保存原图。
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { tokenizeForSearch } from "@/lib/rag/text";
import type {
  AskImageIndexStats,
  ImageEvidence,
  ImageEvidenceKind,
  ImageRegion,
} from "@/types/rag";

import { serverConfig } from "../config";
import { execute, query, queryOne } from "../db";
import { chatJson, type ChatImage } from "../llm/client";
import { cacheGet, cacheSet, redisKey } from "../redis";

const INDEX_VERSION = 1;
const MAX_EVIDENCE = 8;
const MAX_TEXT = 1_400;
const IMAGE_CACHE_TTL_SEC = 7 * 24 * 60 * 60;

function imageCacheKey(hash: string): string {
  return redisKey("image-index", INDEX_VERSION, hash);
}

const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const pointSchema = z.object({
  x: z.union([z.string(), z.number()]),
  y: z.number(),
});

const chartSchema = z.object({
  title: z.string().max(160).optional(),
  type: z.enum(["line", "bar", "scatter", "pie", "diagram", "other"]).optional(),
  xAxis: z.string().max(160).optional(),
  yAxis: z.string().max(160).optional(),
  series: z
    .array(
      z.object({
        label: z.string().max(120),
        points: z.array(pointSchema).max(80),
      }),
    )
    .max(8),
  trend: z.string().max(500).optional(),
  region: regionSchema.optional(),
});

const tableSchema = z.object({
  title: z.string().max(160).optional(),
  columns: z.array(z.union([z.string(), z.number()])).max(16),
  rows: z.array(z.array(z.union([z.string(), z.number()])).max(16)).max(30),
  region: regionSchema.optional(),
});

const analysisSchema = z.object({
  caption: z.string().max(600).optional(),
  ocr: z
    .array(
      z.object({
        text: z.string().min(1).max(MAX_TEXT),
        region: regionSchema.optional(),
      }),
    )
    .max(20)
    .optional(),
  charts: z.array(chartSchema).max(5).optional(),
  tables: z.array(tableSchema).max(4).optional(),
  keyValues: z
    .array(
      z.object({
        label: z.string().max(160),
        value: z.union([z.string(), z.number()]),
        unit: z.string().max(40).optional(),
        region: regionSchema.optional(),
      }),
    )
    .max(24)
    .optional(),
  notes: z.array(z.string().max(300)).max(6).optional(),
});

export type ImageAnalysis = z.infer<typeof analysisSchema>;

export interface ImageIndexResult {
  evidence: ImageEvidence[];
  stats: AskImageIndexStats;
}

const IMAGE_ANALYSIS_SYSTEM = `你是论文图像的结构化抽取器,不是答题助手。只转写和测量图中可见内容,不补造。

输出严格 JSON,不要 Markdown。字段:
{
  "caption": "整张图的用途(≤80字)",
  "ocr": [{"text":"逐字转写的一段可见文字","region":{"x":0,"y":0,"width":1,"height":1}}],
  "charts": [{
    "title":"图题/图例",
    "type":"line|bar|scatter|pie|diagram|other",
    "xAxis":"横轴含义与单位",
    "yAxis":"纵轴含义与单位",
    "series":[{"label":"系列名","points":[{"x":"横轴值(文字或数字)","y":12.3}]}],
    "trend":"图中可直接看出的趋势,不要推断原因",
    "region":{"x":0,"y":0,"width":1,"height":1}
  }],
  "tables":[{"title":"表题","columns":["列1","列2"],"rows":[["值","值"]],"region":{"x":0,"y":0,"width":1,"height":1}}],
  "keyValues":[{"label":"指标名","value":"42.1","unit":"%","region":{"x":0,"y":0,"width":1,"height":1}}],
  "notes":["看不清或无法确定的内容"]
}

规则:
1. region 使用归一化坐标:x/y 为左上角,width/height 为宽高,全部在 0 到 1 之间。
2. OCR 按阅读顺序分段,保留数字、单位、坐标轴刻度和图例原样;不要概括成一句话。
3. 图表能读出的数据点尽量给全;读不出具体点位时,至少转写刻度、图例和可见趋势。
4. 表格保留表头与行,不要把表格改写成散文。
5. 看不清的不要猜;放进 notes。`;

function hashImage(image: ChatImage): string {
  return createHash("sha256")
    .update(image.mimeType)
    .update("\0")
    .update(image.data)
    .digest("hex");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 模型偶尔会返回 0-100 或 0-1000 的坐标;先按最大值判断尺度再归一化。 */
export function normalizeRegion(input: z.infer<typeof regionSchema> | undefined): ImageRegion | undefined {
  if (!input) return undefined;
  const values = [input.x, input.y, input.width, input.height];
  if (!values.every(Number.isFinite)) return undefined;
  const max = Math.max(...values.map(Math.abs));
  const scale = max <= 1 ? 1 : max <= 100 ? 100 : 1000;
  const region = {
    x: clamp01(input.x / scale),
    y: clamp01(input.y / scale),
    width: clamp01(input.width / scale),
    height: clamp01(input.height / scale),
  };
  if (region.width <= 0.002 || region.height <= 0.002) return undefined;
  return region;
}

function uniqNumbers(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/-?\d+(?:\.\d+)?%?/g)) {
      const value = match[0];
      if (value.length <= 24) found.add(value);
      if (found.size >= 16) return [...found];
    }
  }
  return [...found];
}

function trimQuote(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function chartText(chart: z.infer<typeof chartSchema>): string {
  const parts = [
    `图表类型:${chart.type ?? "other"}`,
    chart.xAxis ? `横轴:${chart.xAxis}` : "",
    chart.yAxis ? `纵轴:${chart.yAxis}` : "",
  ].filter(Boolean);
  for (const series of chart.series) {
    const points = series.points
      .slice(0, 32)
      .map((point) => `${point.x}: ${point.y}`)
      .join(", ");
    if (points) parts.push(`${series.label}: ${points}`);
  }
  if (chart.trend) parts.push(`趋势:${chart.trend}`);
  return parts.join("\n");
}

function tableText(table: z.infer<typeof tableSchema>): string {
  const lines: string[] = [];
  if (table.columns.length) lines.push(table.columns.map(String).join(" | "));
  for (const row of table.rows.slice(0, 24)) lines.push(row.map(String).join(" | "));
  return lines.join("\n");
}

/** 纯函数:模型抽取结果 → 带区域和数字的图像证据块。 */
export function buildImageEvidence(
  analysis: ImageAnalysis,
  imageIndex: number,
  imageName: string,
  imageHash: string,
): ImageEvidence[] {
  const drafts: Array<Omit<ImageEvidence, "id" | "imageIndex" | "label">> = [];
  const caption = analysis.caption?.trim();
  if (caption) {
    drafts.push({
      kind: "caption",
      title: `${imageName} · 图像概述`,
      quote: trimQuote(caption),
      numbers: uniqNumbers([caption]),
    });
  }

  for (const block of analysis.ocr ?? []) {
    const text = block.text.trim().slice(0, MAX_TEXT);
    if (!text) continue;
    drafts.push({
      kind: "ocr",
      title: `${imageName} · OCR 文字`,
      quote: trimQuote(text),
      numbers: uniqNumbers([text]),
      region: normalizeRegion(block.region),
    });
  }

  for (const chart of analysis.charts ?? []) {
    const text = chartText(chart);
    if (!text.trim()) continue;
    drafts.push({
      kind: chart.trend ? "trend" : "chart",
      title: `${imageName} · ${chart.title ?? "图表数据"}`,
      quote: trimQuote(text, 360),
      numbers: uniqNumbers([text]),
      region: normalizeRegion(chart.region),
    });
  }

  for (const table of analysis.tables ?? []) {
    const text = tableText(table);
    if (!text.trim()) continue;
    drafts.push({
      kind: "table",
      title: `${imageName} · ${table.title ?? "表格数据"}`,
      quote: trimQuote(text, 360),
      numbers: uniqNumbers([text]),
      region: normalizeRegion(table.region),
    });
  }

  const keyValues = (analysis.keyValues ?? []).filter((item) => String(item.value).trim());
  if (keyValues.length) {
    const text = keyValues
      .slice(0, 20)
      .map((item) => `${item.label}: ${String(item.value)}${item.unit ?? ""}`)
      .join("\n");
    drafts.push({
      kind: "numeric",
      title: `${imageName} · 关键数值`,
      quote: trimQuote(text, 360),
      numbers: uniqNumbers([text]),
      region: normalizeRegion(keyValues[0]?.region),
    });
  }

  if (!drafts.length) {
    drafts.push({
      kind: "caption",
      title: `${imageName} · 待人工核对`,
      quote: "这张图没有完成结构化抽取,请直接查看原图。",
      numbers: [],
    });
  }

  return drafts.map((draft, index) => ({
    ...draft,
    id: `${imageHash.slice(0, 12)}:${imageIndex}:${index + 1}`,
    imageIndex,
    label: `图${imageIndex + 1}-${index + 1}`,
  }));
}

const CHART_CUES =
  /图|图表|曲线|趋势|数值|数据|最高|最低|增长|下降|上升|对比|坐标|横轴|纵轴|多少|占比|百分比|table|chart|trend|axis|metric|figure/i;
const OCR_CUES = /文字|标题|标签|写了|写着|识别|ocr|legend|caption|图中.*(?:写|标)/i;

/**
 * 当前问题与图像块的相关度。
 *
 * 图像块通常很短,BM25 的语料统计不稳定;这里用查询词覆盖 + 意图加成:
 * 问趋势优先图表/趋势块,问数值优先带数字块,问图中文字优先 OCR 块。
 */
export function selectImageEvidence(
  evidence: ImageEvidence[],
  question: string,
  limit = MAX_EVIDENCE,
): ImageEvidence[] {
  if (!evidence.length) return [];
  const queryTokens = new Set(tokenizeForSearch(question));
  const chartIntent = CHART_CUES.test(question);
  const ocrIntent = OCR_CUES.test(question);
  const numericIntent = /\d|多少|几|比例|数值|数据|最高|最低|平均|增长|下降/.test(question);

  const scoreOf = (item: ImageEvidence): number => {
    const text = `${item.title} ${item.quote}`.toLowerCase();
    const tokens = new Set(tokenizeForSearch(text));
    let overlap = 0;
    for (const token of queryTokens) if (tokens.has(token)) overlap++;
    let score = overlap * 1.8;
    if (item.kind === "caption") score += 0.8;
    if (chartIntent && (item.kind === "trend" || item.kind === "chart" || item.kind === "table")) {
      score += 2.4;
    }
    if (ocrIntent && item.kind === "ocr") score += 1.8;
    if (numericIntent && item.numbers.length) score += 1.6;
    return score;
  };

  const ranked = [...evidence].sort(
    (a, b) => scoreOf(b) - scoreOf(a) || a.label.localeCompare(b.label),
  );
  const picked = new Map<string, ImageEvidence>();

  // 每张图至少保留一个概述块,用户才知道回答看了哪几张图。
  const images = [...new Set(evidence.map((item) => item.imageIndex))];
  for (const imageIndex of images) {
    const caption = evidence.find(
      (item) => item.imageIndex === imageIndex && item.kind === "caption",
    );
    if (caption) picked.set(caption.id, caption);
  }
  for (const item of ranked) {
    if (picked.size >= limit) break;
    picked.set(item.id, item);
  }
  return [...picked.values()];
}

/**
 * 抽取缓存放在 Postgres 里,而不是每张图一个小文件:
 * 一次问答可能并发读多张图,文件方案的目录遍历与命名冲突都要自己处理。
 * 缓存键是图片内容哈希,不含账号信息;命中时更新 last_hit_at,便于将来做淘汰。
 */
async function readCached(hash: string): Promise<ImageAnalysis | null> {
  const redisCached = await cacheGet<ImageAnalysis>(imageCacheKey(hash));
  if (redisCached) {
    const checked = analysisSchema.safeParse(redisCached);
    if (checked.success) return checked.data;
  }
  try {
    const row = await queryOne<{ version: number; analysis: ImageAnalysis }>(
      "SELECT version, analysis FROM image_index_cache WHERE hash = $1",
      [hash],
    );
    if (!row || row.version !== INDEX_VERSION) return null;
    const checked = analysisSchema.safeParse(row.analysis);
    if (!checked.success) return null;
    await query("UPDATE image_index_cache SET last_hit_at = $1 WHERE hash = $2", [Date.now(), hash]);
    await cacheSet(imageCacheKey(hash), checked.data, IMAGE_CACHE_TTL_SEC);
    return checked.data;
  } catch {
    return null;
  }
}

async function writeCached(hash: string, analysis: ImageAnalysis): Promise<void> {
  await cacheSet(imageCacheKey(hash), analysis, IMAGE_CACHE_TTL_SEC);
  try {
    const now = Date.now();
    await query(
      `INSERT INTO image_index_cache (hash, version, analysis, created_at, last_hit_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (hash) DO UPDATE SET
         version = excluded.version,
         analysis = excluded.analysis,
         created_at = excluded.created_at,
         last_hit_at = excluded.last_hit_at`,
      [hash, INDEX_VERSION, JSON.stringify(analysis), now, now],
    );
  } catch {
    // 缓存失败不影响本次回答:下次重新抽取即可
  }
}

export interface ImageCachePruneResult {
  deleted: number;
  maxRows: number;
  maxAgeMs: number;
}

/** 删掉太久没命中的图像分析,再把总量裁到行数上限。 */
export async function pruneImageIndexCache(options?: {
  maxRows?: number;
  maxAgeMs?: number;
}): Promise<ImageCachePruneResult> {
  const maxRows = Math.max(100, options?.maxRows ?? serverConfig.cache.imageMaxRows);
  const maxAgeMs = options?.maxAgeMs ?? serverConfig.cache.imageMaxAgeMs;
  const cutoff = Date.now() - maxAgeMs;
  const deleted = await execute(
    `DELETE FROM image_index_cache
     WHERE last_hit_at < $1
        OR hash IN (
          SELECT hash FROM image_index_cache
          ORDER BY last_hit_at DESC
          OFFSET $2
        )`,
    [cutoff, maxRows],
  );
  return { deleted, maxRows, maxAgeMs };
}

async function analyzeImage(
  ownerId: string,
  image: ChatImage,
  signal?: AbortSignal,
): Promise<ImageAnalysis | null> {
  const result = await chatJson(
    {
      ownerId,
      service: "ask",
      system: IMAGE_ANALYSIS_SYSTEM,
      user: "请抽取这张论文图片中的 OCR、表格、图表数据与关键数值,严格按系统要求输出 JSON。",
      images: [image],
      temperature: 0.1,
      maxTokens: 2400,
      timeoutMs: 45_000,
      retries: 0,
      signal,
    },
    analysisSchema,
  );
  return result?.value ?? null;
}

/**
 * 为本次提问建立图像索引。
 *
 * 每张图先查内容哈希缓存,没有命中才调用视觉模型。单张失败会退化为
 * “只有原图的概述块”,不会让整个问答失败。
 */
export async function indexAskImages(
  ownerId: string,
  images: Array<ChatImage & { name?: string }>,
  question: string,
  signal?: AbortSignal,
): Promise<ImageIndexResult> {
  if (!images.length) {
    return {
      evidence: [],
      stats: { images: 0, chunks: 0, numbers: 0, cached: 0, degraded: false },
    };
  }

  let cached = 0;
  let degraded = false;
  const perImage = await Promise.all(
    images.map(async (image, imageIndex) => {
      if (signal?.aborted) return [];
      const chatImage: ChatImage = { mimeType: image.mimeType, data: image.data };
      const hash = hashImage(chatImage);
      let analysis = await readCached(hash);
      if (analysis) cached++;
      else {
        analysis = await analyzeImage(ownerId, chatImage, signal);
        if (analysis) await writeCached(hash, analysis);
      }
      if (!analysis) {
        degraded = true;
        analysis = { caption: `${image.name}：视觉抽取失败，请直接查看原图。` };
      }
      return buildImageEvidence(
        analysis,
        imageIndex,
        image.name ?? `附图 ${imageIndex + 1}`,
        hash,
      );
    }),
  );

  const all = perImage.flat();
  const selected = selectImageEvidence(all, question);
  return {
    evidence: selected,
    stats: {
      images: images.length,
      chunks: all.length,
      numbers: new Set(all.flatMap((item) => item.numbers)).size,
      cached,
      degraded,
    },
  };
}

export function imageEvidenceKindLabel(kind: ImageEvidenceKind): string {
  if (kind === "ocr") return "OCR";
  if (kind === "chart") return "图表";
  if (kind === "trend") return "趋势";
  if (kind === "table") return "表格";
  if (kind === "numeric") return "数值";
  return "概述";
}
