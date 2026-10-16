/**
 * 语义关系判定管道。
 *
 * 两段式,顺序不能反:
 *
 *   ① 硬约束过滤(确定性、不花 token)
 *      年份差、互引检查、共享任务 …… 把候选从 O(n²) 砍到可接受的量级。
 *      这一步完全不会幻觉,而且是**唯一能保证不出现明显错误**的一步。
 *
 *   ② 模型判定(带 rubric 与反例)
 *      只在少量候选上跑,并要求给出原文证据片段。
 *
 * 没有大模型密钥时,第②步降级为启发式打分,并在报告里如实标注 ——
 * 界面上会显示「启发式判定」而不是假装有 AI 结论。
 */

import { z } from "zod";

import type { Evidence, GraphEdge, Provenance, RelationPreset } from "@/types/kg";

import { buildTextIndex, cosineSimilarity, documentOf, type TextIndex } from "@/lib/graph/text";

import { readCache, writeCache } from "../cache";
import { chatJson, llmAvailable } from "../llm/client";
import type { OaWork } from "../sources/openalex";
import { edgeKindOf } from "./presets";

const now = (): string => new Date().toISOString();

/**
 * 并发判定的批大小。
 *
 * 判定之间互不依赖,但也不是越大越好:一次性打出去几十个请求,
 * 供应商侧大概率触发限流,重试反而更慢。4 是在实测里既能压住墙钟时间、
 * 又不会触发限流的档位。
 */
const JUDGE_CONCURRENCY = 4;

/**
 * 一次请求判定几对。
 *
 * 这是**成本优化的主力**:每对论文的判定都要带一遍完整 rubric
 * (判定标准 + 反例 + 系统约束,几百 token)。逐对送审时这份固定开销
 * 会被重复支付 N 次;一次判 5 对,固定开销摊薄到 1/5,
 * 而输入里真正随候选变化的只有两段摘要。
 *
 * 不设更大的原因:批越大,输出越长、越容易在中间截断或漏项,
 * 而一次失败要整批重来的代价也越高。5 是质量与成本之间的折中。
 */
const JUDGE_BATCH = 5;

/** 组装一条语义边。把构造逻辑收在一处,是因为它同时约束了三件事:层的归属、证据的不变式、溯源信息。 */
function makeEdge(
  preset: RelationPreset,
  a: OaWork,
  b: OaWork,
  confidence: number,
  evidence: Evidence[],
  rationale: string,
  provenance: Provenance,
): GraphEdge {
  const source = `paper:${a.id}`;
  const target = `paper:${b.id}`;
  return {
    id: `${source}|${edgeKindOf(preset.id)}|${target}`,
    kind: edgeKindOf(preset.id) as GraphEdge["kind"],
    layer: "semantic",
    source,
    target,
    directed: preset.directed,
    weight: confidence,
    confidence,
    evidence,
    rationale,
    provenance,
  };
}

export interface RelationReport {
  /** 每个预设:候选数 / 判定数 / 命中数 */
  perPreset: Record<
    string,
    { candidates: number; judged: number; matched: number; mode: "llm" | "heuristic" }
  >;
  /** 被核验失败的引用片段数 —— 这个数字本身就是反幻觉能力的证据 */
  rejectedQuotes: number;
  /** 模型调用次数。成本必须可见,否则优化无从谈起。 */
  llmCalls: number;
  /** 估算 token 用量(按字符数折算,用于横向比较不同策略的量级)。 */
  estimatedTokens: number;
  /** 命中缓存、没有重复送审的论文对数 */
  cacheHits: number;
  /** 整批解析失败、退回逐条判定的次数 */
  batchFallbacks: number;
}

/** 一对论文的判定结论。缓存与批处理共用这个形状。 */
interface PairJudgement {
  match: boolean;
  confidence: number;
  rationale: string;
  evidence: Array<{ paperId: string; quote: string }>;
}

const BatchJudgeSchema = z.object({
  results: z.array(
    z.object({
      index: z.number(),
      match: z.boolean(),
      confidence: z.number().min(0).max(1).optional(),
      rationale: z.string().optional(),
      evidence: z.array(z.object({ paperId: z.string(), quote: z.string() })).optional(),
    }),
  ),
});

/** 判定过程中用到的、可由数据源直接算出的事实。 */
export interface PairFeatures {
  i: number;
  j: number;
  citesIJ: boolean;
  citesJI: boolean;
  yearGap: number;
  sharedTopics: string[];
  topicOverlap: number;
  titleSim: number;
  /** 标题 + 摘要的 TF-IDF 余弦。比主题 id 重叠细得多,是排序的主力信号。 */
  textSim: number;
}

const topicIdsOf = (w: OaWork): Set<string> =>
  new Set(w.fields.filter((f) => f.level === "topic").map((f) => f.id));

/** 词集合的 Jaccard 相似度。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const normTitle = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function bigramDice(a: string, b: string): number {
  const x = normTitle(a);
  const y = normTitle(b);
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
  return total ? (2 * inter) / total : 0;
}

/**
 * 生成候选对。
 *
 * 这里刻意**不做全量笛卡尔积**:候选只在「有引用关系」或「共享主题」的论文之间存在。
 * 一篇论文与它毫不相关的另一篇,不需要花任何算力去证明它们不相关。
 */
export function generatePairs(papers: OaWork[], textIndex?: TextIndex): PairFeatures[] {
  const index = new Map<string, number>();
  papers.forEach((w, i) => index.set(w.id, i));

  const cites = new Set<string>();
  papers.forEach((w, i) => {
    for (const ref of w.referencedWorks) {
      const j = index.get(ref);
      if (j !== undefined && j !== i) cites.add(`${i}|${j}`);
    }
  });

  const topics = papers.map(topicIdsOf);

  // 按主题倒排:只在共享主题的论文之间两两配对
  const byTopic = new Map<string, number[]>();
  topics.forEach((set, i) => {
    for (const t of set) {
      const list = byTopic.get(t);
      if (list) list.push(i);
      else byTopic.set(t, [i]);
    }
  });

  const seen = new Set<string>();
  const pairs: PairFeatures[] = [];

  const push = (i: number, j: number) => {
    if (i === j) return;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}|${b}`;
    if (seen.has(key)) return;
    seen.add(key);

    const wa = papers[a];
    const wb = papers[b];
    if (!wa || !wb) return;

    const shared = [...topics[a] ?? []].filter((t) => topics[b]?.has(t));
    pairs.push({
      i: a,
      j: b,
      citesIJ: cites.has(`${a}|${b}`),
      citesJI: cites.has(`${b}|${a}`),
      yearGap: Math.abs((wa.year || 0) - (wb.year || 0)),
      sharedTopics: shared,
      topicOverlap: jaccard(topics[a] ?? new Set(), topics[b] ?? new Set()),
      titleSim: bigramDice(wa.title, wb.title),
      textSim: textIndex ? cosineSimilarity(textIndex, wa.id, wb.id) : 0,
    });
  };

  for (const list of byTopic.values()) {
    // 单个主题下的论文太多时先截断:一个主题挂几千篇说明它区分度太低
    const capped = list.length > 60 ? list.slice(0, 60) : list;
    for (let x = 0; x < capped.length; x++) {
      for (let y = x + 1; y < capped.length; y++) {
        const i = capped[x];
        const j = capped[y];
        if (i === undefined || j === undefined) continue;
        push(i, j);
      }
    }
  }
  for (const k of cites) {
    const [a, b] = k.split("|").map(Number);
    if (a !== undefined && b !== undefined) push(a, b);
  }

  return pairs;
}

/** 硬约束:全部是确定性规则,不涉及模型。返回 false 表示这个候选连送审的资格都没有。 */
export function passesHardConstraints(f: PairFeatures, preset: RelationPreset): boolean {
  const c = preset.hardConstraints;

  if (c.maxYearGap !== undefined && f.yearGap > c.maxYearGap) return false;

  if (c.requireCitation && !f.citesIJ && !f.citesJI) return false;

  if (c.requireMutualNonCitation && (f.citesIJ || f.citesJI)) return false;

  if (c.requireSharedTask && f.sharedTopics.length === 0) return false;

  // minSimilarity 走文本相似度而不是主题 id 重叠:后者的分辨率太粗,
  // 同一个子领域下的论文会全部落在同一档,起不到筛选作用
  if (c.minSimilarity !== undefined && f.textSim < c.minSimilarity) return false;

  return true;
}

/**
 * 启发式打分 —— 既用于给候选排序(决定谁先送到模型那里),
 * 也在没有大模型时作为降级判定。
 *
 * 它刻意做得很保守:只利用数据源里已有的事实(引用、年份、主题、标题),
 * 不给任何「读起来像」的判断。宁可少给几条,也不制造无法核验的结论。
 */
export function heuristicScore(f: PairFeatures, preset: RelationPreset): number {
  /**
   * 这个分数有两个用途,别混淆:
   *   ① 给候选**排序** —— 决定哪些对先送审。这里最重要的信号是 textSim,
   *      因为"两篇论文像不像"是"它们之间有没有关系"的最好代理。
   *   ② 没有模型时作为**降级判定** —— 那时它是结论,必须保守。
   *
   * 早先的版本用 OpenAlex 的主题 id 重叠当主信号,排序质量差:
   * 实测 60 次判定只挖出 6 条关系,命中率 10%,额度基本花在了无关对上。
   * 换成标题 + 摘要的 TF-IDF 余弦之后,排在前面的才真的是"可能有关"的论文。
   */
  const text = f.textSim;

  switch (preset.id) {
    case "baseline":
    case "extends": {
      if (!f.citesIJ && !f.citesJI) return 0;
      const recency = 1 - Math.min(1, f.yearGap / 8);
      return 0.3 + 0.45 * text + 0.25 * recency;
    }
    case "contemporary": {
      if (f.citesIJ || f.citesJI) return 0;
      const closeness = 1 - f.yearGap / 3;
      return 0.25 + 0.4 * text + 0.35 * closeness;
    }
    case "similar":
      return 0.15 + 0.7 * text + 0.15 * f.titleSim;
    case "alternative":
      // 「同任务异方法」要的是同一任务下的不同路线,所以**不是**越不像越好:
      // 主题上应该接近,方法上应该分岔。排序阶段只看前者,后者交给模型。
      return 0.2 + 0.6 * text + 0.2 * Math.min(1, f.sharedTopics.length / 2);
    case "contradicts":
      // 矛盾关系无法从元数据推断,只有模型读过摘要才可能判定。
      // 但**排序**仍然可以借文本相似度:结论矛盾的两篇,必然在讨论同一件事。
      return 0.2 + 0.8 * text;
    default:
      return 0;
  }
}

const JudgeSchema = z.object({
  match: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  evidence: z
    .array(
      z.object({
        paperId: z.string(),
        quote: z.string(),
      }),
    )
    .optional(),
});

const COMMON_RULES = `通用规则:
1. 提供的「反例」是判断边界,遇到反例描述的情况必须判为不成立。
2. 拿不准就判 match = false。宁可漏判,不要误判。
3. confidence 要如实反映你的把握程度,不要一律给高分。

只输出 JSON,格式:
{"match": true|false, "confidence": 0-1, "rationale": "一到两句话说明理由", "evidence": [{"paperId": "...", "quote": "..."}]}`;

/**
 * 判定用的系统提示词,按证据标准分两套。
 *
 * 这个区分来自一次实测:六类关系全部 matched = 0。原因是我用同一套标准
 * 要求了所有关系 —— 而「基线」「扩展」这类关系的判据是**引文结构与学术角色**,
 * 摘要里通常不会写「我们以 X 作为基线」(那在正文的实验章节)。
 * 要求逐字引用摘要,等于要求模型证明一件摘要里根本不存在的事,
 * 于是它只能全部判 false。
 *
 * 分两套之后,规则与手头的数据终于对上了:
 *   structural —— 允许使用领域常识判断学术角色,证据以引用记录与元数据为主
 *   textual    —— 必须给出可核验的原文片段,那是判断内容关系的唯一可靠依据
 */
export function judgeSystem(policy: "structural" | "textual"): string {
  if (policy === "textual") {
    return `你是一名严谨的学术文献分析助手,任务是在两篇论文之间判定一种**内容层面的关系**。

这类关系的判断只能从论文本身读出来,因此:
1. 只依据给定的标题与摘要判断,不得引入摘要之外的信息。
2. evidence 里必须是摘要中**逐字出现的片段**,不能改写、不能概括。
3. 如果找不到能支撑判定的原文片段,必须判 match = false。

${COMMON_RULES}`;
  }

  return `你是一名资深的研究者,任务是在两篇论文之间判定一种**学术角色关系**。

这类关系的判据是研究者在领域中的实际位置,不是某句话字面写了什么:
1. 允许使用你对该领域的常识判断角色(例如某篇是否为公认的基线方法)。
2. 摘要里通常不会写明「我们以 X 作为基线」——那写在正文的实验章节,不要因为摘要没提就否定。
3. 但也不能凭空拔高:如果两篇只是同领域、并没有实际的方法沿袭或对照关系,必须判 false。
4. evidence 里能给出原文片段最好;给不出就留空,不要为了凑证据而编造。

${COMMON_RULES}`;
}

/** 把证据片段核验回原文。模型编造的引用会在这里被拦下。 */

/**
 * 结构类关系的证据。
 *
 * 这类关系的判据本来就是引用与元数据,所以证据就用这些**可公开核验的事实**来写,
 * 而不是硬塞一段原文。界面上会把它标成「结构化依据」,
 * 与「原文片段」区分开 —— 两者的可信度不同,呈现方式也不该相同。
 */
function structuralEvidence(f: PairFeatures, a: OaWork, b: OaWork): Evidence {
  const citer = f.citesIJ ? a : f.citesJI ? b : null;
  const cited = f.citesIJ ? b : f.citesJI ? a : null;

  if (citer && cited) {
    return {
      kind: "citation",
      paperId: `paper:${citer.id}`,
      cites: `paper:${cited.id}`,
      note: `引用记录来自 OpenAlex;两篇发表年份相差 ${f.yearGap} 年`,
    };
  }

  return {
    kind: "metadata",
    note: `依据引文结构与发表元数据判定:${
      f.citesIJ || f.citesJI ? "存在引用关系" : "两者互不引用"
    },年份差 ${f.yearGap} 年,共享主题 ${f.sharedTopics.length} 个`,
    fields: {
      yearGap: f.yearGap,
      sharedTopics: f.sharedTopics.length,
      topicOverlap: Number(f.topicOverlap.toFixed(3)),
      aYear: a.year,
      bYear: b.year,
    },
  };
}

function verifyQuotes(
  raw: Array<{ paperId: string; quote: string }>,
  byId: Map<string, OaWork>,
): { evidence: Evidence[]; rejected: number } {
  const evidence: Evidence[] = [];
  let rejected = 0;

  for (const item of raw) {
    const work = byId.get(item.paperId.replace(/^paper:/, ""));
    const quote = item.quote.trim();
    if (!work || quote.length < 12) {
      rejected++;
      continue;
    }

    // 归一化空白后做子串匹配 —— 这是「引用核验」最简形式的实现
    const haystack = `${work.title} ${work.abstract ?? ""}`.replace(/\s+/g, " ");
    const needle = quote.replace(/\s+/g, " ");
    if (!haystack.includes(needle)) {
      rejected++;
      continue;
    }

    const isInTitle = work.title.replace(/\s+/g, " ").includes(needle);
    evidence.push({
      kind: "span",
      paperId: `paper:${work.id}`,
      section: isInTitle ? "title" : "abstract",
      quote,
      // 摘要尚无字符级切块,先用 0 长度定位占位;接入全文切块后改为真实偏移
      locator: { chunkId: `abstract:${work.id}`, start: 0, end: quote.length },
      score: 0.9,
    });
  }

  return { evidence, rejected };
}

export function pairPrompt(f: PairFeatures, a: OaWork, b: OaWork, preset: RelationPreset): string {
  const relation = f.citesIJ
    ? `${a.id} 引用了 ${b.id}`
    : f.citesJI
      ? `${b.id} 引用了 ${a.id}`
      : "两者之间没有引用关系";

  const fmt = (w: OaWork) =>
    [
      `id: ${w.id}`,
      `标题: ${w.title}`,
      `年份: ${w.year}`,
      w.venue ? `发表: ${w.venue}` : null,
      `被引: ${w.citedByCount}`,
      `摘要: ${(w.abstract ?? "(无摘要)").slice(0, 1200)}`,
    ]
      .filter(Boolean)
      .join("\n");

  return `## 待判定的关系:${preset.label}(${preset.labelEn})

判定标准:
${preset.definition}

反例(出现以下情况必须判为不成立):
${preset.negativeExamples}

## 客观事实
${relation}
年份差:${f.yearGap} 年
共享主题:${f.sharedTopics.length ? f.sharedTopics.join(", ") : "(无)"}

## 论文 A
${fmt(a)}

## 论文 B
${fmt(b)}

请判定:A 与 B 是否构成「${preset.label}」关系。注意关系的方向性:${
    preset.directed ? "有向" : "无向"
  }。`;
}

export interface RelationPipelineOptions {
  presets: RelationPreset[];
  /** 每个预设最多送审多少对候选 */
  candidateLimit?: number;
  /**
   * 每个预设施加给模型的**硬上限**。
   *
   * 没有它的时候:6 个预设 × 40 个候选 = 240 次模型调用,一次建图就会
   * 烧掉可观的额度,用户还要等好几分钟。有价值的候选永远排在最前面
   * (排序用的就是启发式分),所以砍掉尾巴的损失远小于成本收益。
   */
  maxJudgedPerPreset?: number;
  /** 每篇种子论文最多保留多少条该关系的边 */
  perSeedLimit?: number;
  /** 种子论文:它们之间的边在配额上单独计数 */
  seedOaIds?: string[];
  /**
   * 探索中心。默认等于 seedOaIds。
   *
   * 候选只从中心向外生成 —— 这个集合决定了"图能长多远":
   * 只给种子,图就是种子加一圈;把结构核一起放进来,才谈得上语义层当主体。
   */
  centerOaIds?: string[];
  onProgress?: (msg: string) => void;
}

export async function buildSemanticEdges(
  papers: OaWork[],
  opts: RelationPipelineOptions,
): Promise<{ edges: GraphEdge[]; report: RelationReport }> {
  const {
    presets,
    candidateLimit = 40,
    maxJudgedPerPreset = 12,
    seedOaIds = [],
    centerOaIds = seedOaIds,
  } = opts;
  /**
   * 排序用的文本索引。
   *
   * 建一次索引的开销是 O(语料),而它能把"送审的对"从随机挑变成挑最像的,
   * 因此是整条管道里性价比最高的一步 —— 比多送审几十对的收益大得多。
   */
  const textIndex = buildTextIndex(
    papers.map((w) => ({ id: w.id, text: documentOf(w.title, w.abstract) })),
  );
  const pairs = generatePairs(papers, textIndex);
  const useLlm = llmAvailable();

  const edges: GraphEdge[] = [];
  const report: RelationReport = {
    perPreset: {},
    rejectedQuotes: 0,
    llmCalls: 0,
    estimatedTokens: 0,
    cacheHits: 0,
    batchFallbacks: 0,
  };
  const perSeedCount = new Map<string, number>();

  for (const preset of presets) {
    if (!preset.enabled) continue;

    /**
     * 有模型就全部交给模型。
     *
     * 这里一度把「结论矛盾」排除在模型判定之外 —— 理由是它的启发式打分恒为 0。
     * 但那正好把因果搞反了:矛盾关系恰恰是**唯一必须读摘要才能判断**的关系,
     * 元数据里根本没有它的信号。排除它的结果就是这一类边永远为空。
     */
    const mode: "llm" | "heuristic" = useLlm ? "llm" : "heuristic";
    report.perPreset[preset.id] = { candidates: 0, judged: 0, matched: 0, mode };

    const eligible = pairs.filter((f) => passesHardConstraints(f, preset));
    report.perPreset[preset.id]!.candidates = eligible.length;

    /**
     * 先筛「必须涉及探索中心」,再按分数排序取前 N —— 顺序不能反。
     *
     * 反过来的后果很隐蔽:高分候选往往是两篇高被引论文之间的强关系,
     * 它们跟中心无关,于是**占满了全部名额**,真正需要判断的那批
     * 一条都进不去。实测表现就是 judged 恒为 0、界面上一条语义边都没有,
     * 而候选总数看起来完全正常。
     */
    const centerRelated = eligible.filter((f) => {
      if (centerOaIds.length === 0) return true;
      const a = papers[f.i];
      const b = papers[f.j];
      return Boolean(a && b && (centerOaIds.includes(a.id) || centerOaIds.includes(b.id)));
    });

    const ranked = centerRelated
      .map((f) => ({ f, s: heuristicScore(f, preset) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, candidateLimit);

    let judgedCount = 0;
    let matchedTotal = 0;
    let cursor = 0;
    const chunkSize = JUDGE_BATCH * JUDGE_CONCURRENCY;

    while (cursor < ranked.length) {
      // 已经攒够这类关系要显示的条数,再问模型就是浪费
      if (matchedTotal >= preset.maxPerSeed) break;
      // 硬上限:防止一个高产预设把额度吃光
      if (mode === "llm" && judgedCount >= maxJudgedPerPreset) break;

      const remain = mode === "llm" ? maxJudgedPerPreset - judgedCount : chunkSize;
      const slice = ranked.slice(cursor, cursor + Math.min(chunkSize, remain));
      cursor += slice.length;
      if (!slice.length) break;

      // ---- 归一化方向 + 配额过滤 ----
      const prepared: PreparedPair[] = [];
      for (const { f, s } of slice) {
        let a = papers[f.i];
        let b = papers[f.j];
        if (!a || !b) continue;

        /**
         * 有向关系的**方向必须按引用来定,不能按下标定**。
         *
         * 候选对是按节点下标 (i < j) 生成的,下标顺序与时间顺序无关。
         * 「基线」的定义是「A 是 B 的基线」,如果 A/B 顺序随机,
         * 一半的候选就是反的 —— 一个严谨的模型会如实判为不成立。
         * 实测表现就是候选有几百条、judged 也有十几条,但 matched 恒为 0。
         *
         * 规则:i 引用了 j,说明 j 更早、是被当作基础的那一方,
         * 于是把 j 放成 A、i 放成 B。
         */
        if (preset.directed && f.citesIJ) {
          const t = a;
          a = b;
          b = t;
        }

        // 每篇种子论文的配额:防止一个高产预设淹没整张图
        const quotaKey = `${preset.id}:${seedOaIds.includes(b.id) ? b.id : a.id}`;
        if ((perSeedCount.get(quotaKey) ?? 0) >= preset.maxPerSeed) continue;

        prepared.push({ f, s, a, b, quotaKey });
      }
      if (!prepared.length) continue;

      // ---- 无模型:本地启发式,一次算完 ----
      if (mode === "heuristic") {
        for (const p of prepared) {
          if (matchedTotal >= preset.maxPerSeed) break;
          const edge = heuristicEdge(preset, p, report);
          if (!edge) continue;
          edges.push(edge);
          perSeedCount.set(p.quotaKey, (perSeedCount.get(p.quotaKey) ?? 0) + 1);
          report.perPreset[preset.id]!.matched++;
          matchedTotal++;
        }
        continue;
      }

      // ---- 有模型:先查缓存,只对没判过的送审 ----
      judgedCount += prepared.length;
      report.perPreset[preset.id]!.judged += prepared.length;
      const verdicts = new Map<number, PairJudgement>();
      const pending: number[] = [];

      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        if (!p) continue;
        const hit = await readJudgement(preset, p.a.id, p.b.id);
        if (hit) {
          verdicts.set(i, hit);
          report.cacheHits++;
        } else {
          pending.push(i);
        }
      }

      // ---- 分批送审,批间并发 ----
      const batches = chunkIndexes(pending, JUDGE_BATCH);
      await runConcurrent(batches, JUDGE_CONCURRENCY, async (batch) => {
        const items = batch.map((i) => prepared[i]).filter((p): p is PreparedPair => Boolean(p));
        const got = await judgeBatch(preset, items, report);
        if (got) {
          batch.forEach((i, k) => {
            const v = got.get(k);
            if (v) verdicts.set(i, v);
          });
          return;
        }
        // 整批解析失败:退回逐条判定,宁可慢一点也不丢结论
        report.batchFallbacks++;
        for (const i of batch) {
          const p = prepared[i];
          if (!p) continue;
          const single = await judgePair(preset, p, report);
          if (single) verdicts.set(i, single);
        }
      });

      // ---- 落边并回写缓存 ----
      for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        const v = verdicts.get(i);
        if (!p || !v) continue;

        await writeJudgement(preset, p.a.id, p.b.id, v);
        if (matchedTotal >= preset.maxPerSeed) continue;
        const edge = judgementToEdge(preset, p, v, report);
        if (!edge) continue;

        edges.push(edge);
        perSeedCount.set(p.quotaKey, (perSeedCount.get(p.quotaKey) ?? 0) + 1);
        report.perPreset[preset.id]!.matched++;
        matchedTotal++;
      }
    }
  }

  return { edges, report };
}

/** 排序后待判定的一对:已归一化方向、已算好配额键。 */
interface PreparedPair {
  f: PairFeatures;
  s: number;
  a: OaWork;
  b: OaWork;
  quotaKey: string;
}

function chunkIndexes(list: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 有上限的并发执行。批次之间不依赖,天然可并行。 */
async function runConcurrent<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) break;
      await work(item);
    }
  });
  await Promise.all(workers);
}

function judgementKey(preset: RelationPreset, aId: string, bId: string): string {
  // 提示词版本进键:判定标准一改,旧结论必须自动失效
  return `${preset.id}|${preset.promptVersion}|${aId}|${bId}`;
}

function readJudgement(
  preset: RelationPreset,
  aId: string,
  bId: string,
): Promise<PairJudgement | null> {
  return readCache<PairJudgement>("relations", judgementKey(preset, aId, bId));
}

function writeJudgement(
  preset: RelationPreset,
  aId: string,
  bId: string,
  value: PairJudgement,
): Promise<boolean> {
  return writeCache("relations", judgementKey(preset, aId, bId), value);
}

/** 批量判定的提示词。一次问多对,把 rubric 的成本摊薄。 */
function batchPrompt(preset: RelationPreset, items: PreparedPair[]): string {
  const blocks = items.map((p, i) => {
    const relation = p.f.citesIJ
      ? `${p.a.id} 引用了 ${p.b.id}`
      : p.f.citesJI
        ? `${p.b.id} 引用了 ${p.a.id}`
        : "两者之间没有引用关系";
    return `[${i + 1}]
客观事实:${relation};年份差 ${p.f.yearGap} 年;共享主题 ${
      p.f.sharedTopics.length ? p.f.sharedTopics.join(", ") : "(无)"
    }
A) ${p.a.id} · ${p.a.year} · ${p.a.title}
   摘要: ${(p.a.abstract ?? "(无摘要)").slice(0, 700)}
B) ${p.b.id} · ${p.b.year} · ${p.b.title}
   摘要: ${(p.b.abstract ?? "(无摘要)").slice(0, 700)}`;
  });

  return `## 关系类型:${preset.label}(${preset.labelEn})
${preset.directed ? "(有向:A 是关系的主体)" : "(无向)"}

判定标准:
${preset.definition}

反例(出现以下情况必须判为不成立):
${preset.negativeExamples}

## 待判定 ${items.length} 对
${blocks.join("\n\n")}

逐对给出结论,每对都必须出现在 results 里。`;
}

const BATCH_SYSTEM_SUFFIX = `

你会一次收到多对论文。请对**每一对**独立判定,不要互相影响。
只输出 JSON:
{"results":[{"index":1,"match":true|false,"confidence":0-1,"rationale":"...","evidence":[{"paperId":"...","quote":"..."}]}]}`;

/**
 * 送一批,拿回逐条结论。
 *
 * 返回 null 表示**整批不可用**(网络失败或输出不合规),由调用方退回逐条判定。
 * 单条缺失不算整批失败 —— 其余仍然有效,这条会在下一轮补判或被跳过。
 */
async function judgeBatch(
  preset: RelationPreset,
  items: PreparedPair[],
  report: RelationReport,
): Promise<Map<number, PairJudgement> | null> {
  if (!items.length) return new Map();

  const system = judgeSystem(preset.evidencePolicy) + BATCH_SYSTEM_SUFFIX;
  const user = batchPrompt(preset, items);
  report.llmCalls++;
  report.estimatedTokens += Math.ceil((system.length + user.length) / 2.4);

  const res = await chatJson({ system, user, temperature: 0.05, maxTokens: 2200 }, BatchJudgeSchema);
  if (!res) return null;

  const out = new Map<number, PairJudgement>();
  for (const r of res.value.results) {
    const idx = r.index - 1;
    if (idx < 0 || idx >= items.length) continue;
    out.set(idx, {
      match: r.match,
      confidence: r.confidence ?? 0.7,
      rationale: r.rationale ?? "",
      evidence: r.evidence ?? [],
    });
  }
  return out.size ? out : null;
}

/** 逐条判定。批处理失败时的兜底,也是质量优先时的降级路径。 */
async function judgePair(
  preset: RelationPreset,
  p: PreparedPair,
  report: RelationReport,
): Promise<PairJudgement | null> {
  const system = judgeSystem(preset.evidencePolicy);
  const user = pairPrompt(p.f, p.a, p.b, preset);
  report.llmCalls++;
  report.estimatedTokens += Math.ceil((system.length + user.length) / 2.4);

  const res = await chatJson({ system, user, temperature: 0.05, maxTokens: 900 }, JudgeSchema);
  if (!res) return null;
  return {
    match: res.value.match,
    confidence: res.value.confidence ?? 0.7,
    rationale: res.value.rationale ?? "",
    evidence: res.value.evidence ?? [],
  };
}

/**
 * 结论 → 边。
 *
 * 这里是**证据标准的两条出口**,也是全系统反幻觉主张的落点:
 *   structural —— 判据是引文结构与学术角色,拿不到原文片段是正常的,
 *                 用可核验的结构事实作为证据,并如实标注来源;
 *   textual    —— 拿不到原文片段就必须丢弃。那类判断一旦没有原文支撑,
 *                 和让模型自由发挥没有区别。
 */
function judgementToEdge(
  preset: RelationPreset,
  p: PreparedPair,
  v: PairJudgement,
  report: RelationReport,
): GraphEdge | null {
  if (!v.match) return null;

  const byId = new Map<string, OaWork>([
    [p.a.id, p.a],
    [p.b.id, p.b],
  ]);
  const verified = verifyQuotes(v.evidence, byId);
  report.rejectedQuotes += verified.rejected;
  let evidence = verified.evidence;

  if (!evidence.length) {
    if (preset.evidencePolicy === "textual") return null;
    evidence = [structuralEvidence(p.f, p.a, p.b)];
  }

  return makeEdge(preset, p.a, p.b, v.confidence, evidence, v.rationale, {
    source: "llm",
    ref: `${p.a.id}->${p.b.id}`,
    promptVersion: preset.promptVersion,
    at: now(),
  });
}

/** 没有模型时的本地判定。保守、无原文证据,但如实标注来源。 */
function heuristicEdge(
  preset: RelationPreset,
  p: PreparedPair,
  report: RelationReport,
): GraphEdge | null {
  void report;
  if (preset.id === "contradicts") return null; // 没有模型就诚实地不给结论
  if (p.s < 0.55) return null;

  return makeEdge(
    preset,
    p.a,
    p.b,
    p.s,
    [
      {
        kind: "metadata",
        note: `引用关系:${p.f.citesIJ ? "A→B" : p.f.citesJI ? "B→A" : "无"};共享主题 ${p.f.sharedTopics.length} 个;标题相似度 ${(p.f.titleSim * 100).toFixed(0)}%`,
        fields: {
          yearGap: p.f.yearGap,
          topicOverlap: Number(p.f.topicOverlap.toFixed(3)),
          titleSimilarity: Number(p.f.titleSim.toFixed(3)),
        },
      },
    ],
    "启发式判定(未配置大模型):依据引用关系、年份差与主题重叠度。",
    { source: "algorithm", ref: `heuristic:${preset.id}`, at: now() },
  );
}

/** 供图例与设置页使用:预设 → 视觉编码。 */
export function legendOf(presets: RelationPreset[]): Array<{
  id: string;
  label: string;
  description: string;
  tone: string;
  dash?: string;
  directed: boolean;
}> {
  return presets
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      tone: p.visual.tone,
      dash: p.visual.dash,
      directed: p.directed,
    }));
}
