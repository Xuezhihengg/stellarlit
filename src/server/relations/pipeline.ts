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
 * 而一次失败要整批重来的代价也越高。4 是质量与成本之间的折中。
 */
const MULTI_BATCH = 4;

/**
 * 送进提示词的摘要长度上限。
 *
 * 从 700 压到 400 的依据:论文摘要的第一段几乎总是"问题 + 方法 + 结果",
 * 而后面主要是实验细节与罗列 —— 判断"这两篇是什么关系"用不到那些。
 * 批量判定时这一项是输入 token 的主要来源(每批 4 对 = 8 段摘要),
 * 砍掉 43% 直接反映在账单上,而判定质量在实测里没有可感知的变化。
 *
 * 逐条判定走同一个常量,保证两种路径看到的信息一致 ——
 * 否则批处理失败退回逐条时,结论会莫名地不一样。
 */
const ABSTRACT_CHARS = 400;

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
  /** 每个预设:候选数 / 参与判定的论文对数 / 实际落边数 */
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
  /** 这一对的全部可判关系都命中缓存、没有任何模型调用的论文对数 */
  cacheHits: number;
  /** 整批解析失败或批内漏项、退回逐对判定的次数 */
  batchFallbacks: number;
  /**
   * 本轮实际判定过的论文对(键 `${idA}|${idB}`,无序)。
   * 传递扩展靠它把上一轮判过的排除掉 —— 否则下一轮的排序结果
   * 会和上一轮几乎重合,新的一层什么也长不出来。
   */
  judgedPairs: string[];
}

/** 单条关系的判定结论。多标签判定在它上面加上 relationId。 */
interface PairJudgement {
  match: boolean;
  confidence: number;
  rationale: string;
  evidence: Array<{ paperId: string; quote: string }>;
}

/** 多标签判定里,模型对一对论文给出的单条关系结论。 */
export interface MultiLabelVerdict extends PairJudgement {
  relationId: string;
  match: true;
}

/** 模型原始返回的单条标签,字段都可能缺失,归一化后再变成 MultiLabelVerdict。 */
export interface MultiLabelCandidate {
  relationId: string;
  confidence?: number | null;
  rationale?: string | null;
  evidence?: Array<{ paperId: string; quote: string }> | null;
}

const MultiLabelSchema = z.object({
  relationId: z.string(),
  confidence: z.number().nullable().optional(),
  rationale: z.string().nullable().optional(),
  evidence: z.array(z.object({ paperId: z.string(), quote: z.string() })).nullable().optional(),
});

const MultiBatchSchema = z.object({
  results: z.array(
    z.object({
      index: z.coerce.number(),
      labels: z.array(MultiLabelSchema).nullable().optional(),
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

/**
 * 关系候选的领域标签。
 *
 * OpenAlex 会同时给出 field / subfield / topic 三级;Semantic Scholar 的
 * 回退源却只有 field 级。早先这里只取 topic,导致 arXiv/S2 来源的论文
 * 全部没有共享主题 —— “同任务异方法”“同期”“结论矛盾”的候选直接归零,
 * 图上只剩少量基线/扩展边。按由细到粗回退,既保留 OpenAlex 的精度,
 * 也让回退源至少能进入语义判定。
 */
function topicIdsOf(w: OaWork): Set<string> {
  for (const level of ["topic", "subfield", "field"] as const) {
    const ids = new Set(w.fields.filter((f) => f.level === level).map((f) => f.id));
    if (ids.size) return ids;
  }
  return new Set();
}

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

  if (typeof c.maxYearGap === "number" && f.yearGap > c.maxYearGap) return false;

  if (c.requireCitation && !f.citesIJ && !f.citesJI) return false;

  if (c.requireMutualNonCitation && (f.citesIJ || f.citesJI)) return false;

  if (c.requireSharedTask && f.sharedTopics.length === 0) return false;

  // minSimilarity 走文本相似度而不是主题 id 重叠:后者的分辨率太粗,
  // 同一个子领域下的论文会全部落在同一档,起不到筛选作用
  if (typeof c.minSimilarity === "number" && f.textSim < c.minSimilarity) return false;

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
      // 用户自定义/未来新增的关系没有专属打分公式时,退回文本相似度。
      // 返回 0 会让这类关系连送审资格都没有 —— 扩展性不能只写在 schema 里。
      return 0.2 + 0.8 * text;
  }
}

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
function structuralEvidence(
  f: PairFeatures,
  a: OaWork,
  b: OaWork,
  citation: MultiPreparedPair["citation"],
): Evidence {
  if (citation !== "none") {
    return {
      kind: "citation",
      paperId: `paper:${b.id}`,
      cites: `paper:${a.id}`,
      note:
        citation === "mutual"
          ? `引用记录来自 OpenAlex;两篇互相引用,年份相差 ${f.yearGap} 年`
          : `引用记录来自 OpenAlex;B 引用 A,年份相差 ${f.yearGap} 年`,
    };
  }

  return {
    kind: "metadata",
    note: `依据引文结构与发表元数据判定:两者互不引用,年份差 ${f.yearGap} 年,共享主题 ${f.sharedTopics.length} 个`,
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
  // 调用方负责先 orientPair:有引用时 a 是被引用方、b 是引用方
  const relation =
    f.citesIJ && f.citesJI
      ? `${a.id} 与 ${b.id} 互相引用`
      : f.citesIJ || f.citesJI
        ? `${b.id} 引用了 ${a.id}`
        : "两者之间没有引用关系";

  const fmt = (w: OaWork) =>
    [
      `id: ${w.id}`,
      `标题: ${w.title}`,
      `年份: ${w.year}`,
      w.venue ? `发表: ${w.venue}` : null,
      `被引: ${w.citedByCount}`,
      `摘要: ${(w.abstract ?? "(无摘要)").slice(0, ABSTRACT_CHARS * 2)}`,
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

/** 一对论文同时送审时,已经归一化方向、并带上了它有资格参与的关系。 */
interface MultiPreparedPair {
  f: PairFeatures;
  a: OaWork;
  b: OaWork;
  eligible: RelationPreset[];
  /** 候选对里所有可判关系的最高启发式分,用于决定谁先送审。 */
  score: number;
  /** 每个可判关系各自的启发式分。没有模型时仍按各自的门槛判定。 */
  scoreByPreset: Map<string, number>;
  /** 无序论文对键,用于去重、跳过与缓存。 */
  pairKey: string;
  /** 归一化方向后的引用事实:非互引时恒为 B 引用 A。 */
  citation: "none" | "b-cites-a" | "mutual";
}

/**
 * 方向归一化:有引用时,把被引用的一方放成 A、引用的一方放成 B。
 *
 * 这样同一对论文只需要送审一次,「基线」「扩展」也不会拿到反方向的文本。
 * 无引用时保持原顺序;有向关系本来就被 requireCitation 挡在候选之外。
 */
export function orientPair(
  f: PairFeatures,
  a: OaWork,
  b: OaWork,
): { a: OaWork; b: OaWork } {
  if (f.citesIJ) return { a: b, b: a };
  return { a, b };
}

function pairKeyOf(f: PairFeatures, papers: OaWork[]): string {
  const a = papers[f.i]?.id ?? "";
  const b = papers[f.j]?.id ?? "";
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 多标签判定的系统提示词。
 *
 * 与单标签版本的区别不是「一次问六次」,而是**先分类再收敛**:
 * 模型对一对论文返回所有成立的关系,硬约束决定每对能选哪些关系,
 * 未知 id 或越界的结论会在 normalizeMultiLabels 里被丢掉。
 */
export function multiLabelSystem(): string {
  return `你是一名严谨的学术文献分析助手。你会收到若干对论文,以及一份关系类型清单。
你的任务不是给每对论文挑一个最像的关系,而是找出**所有成立的关系**;一对论文可以同时成立多条,也可以一条都不成立。

通用规则:
1. 只判断清单里的关系,relationId 必须与清单中的 id 完全一致。
2. 每对论文会给出「可判关系」——那是通过硬约束的候选集合。只能从可判关系里返回,不要越界。
3.「判定标准」定正例,「反例」定边界;出现反例描述的情况必须不判。
4.「典型句式」只是识别线索,不是必要条件。论文没有使用那句话,但实质符合判定标准时仍应判成立;反过来,只是出现相似措辞也不够。
5. 先看核心条件是否成立。核心条件成立、且没有触发反例时,应如实标注;不要因为表述含蓄、方法描述简略,或你个人觉得「也许还能更精确」就一律否定。
6. 引用事实已经由系统核验。不要因为摘要里没有再次写「我们引用了谁」而否定引用;但仍要判断这次引用是否构成该关系的实质使用。
7. 真正模棱两可、无法从标题与摘要确认核心条件时才不判。不要把「有一点像」当成成立,也不要为了保守而漏掉明确关系。
8. 同一对论文可以有多个标签,但每条都要独立满足自己的标准;不要为了凑多标签而重复判定。
9. 方向已经统一:若存在引用,A 是被引用的一方,B 是引用的一方(通常 A 更早);有向关系按这个方向判断。
10. 证据标准写在关系清单里:
   - structural:允许用引用记录、年份、主题等结构事实,evidence 可以为空;
   - textual:必须给出摘要中逐字出现的 quote,不能改写、不能概括;给不出就不要判这条。
11. quote 必须能在给定标题或摘要中逐字找到;不要编造。
12. confidence 取 0–1,如实反映把握程度。核心条件明确成立但证据来自摘要概述时可取 0.6–0.75,有明确对比/改进语句时可取 0.8 以上。

只输出 JSON:
{"results":[{"index":1,"labels":[{"relationId":"baseline","confidence":0.8,"rationale":"一到两句话","evidence":[{"paperId":"W...","quote":"..."}]}]}]}
没有成立的关系时 labels 为空数组。每一对都必须出现在 results 里。`;
}

/** 关系清单:把 rubric、方向与证据标准放在同一处,避免模型记错某一类。 */
export function multiLabelTaxonomy(presets: RelationPreset[]): string {
  return presets
    .map((preset, index) => {
      const direction = preset.directed
        ? "有向(A 是被引用/较早的一方,B 是引用/较晚的一方)"
        : "无向";
      const evidence =
        preset.evidencePolicy === "textual"
          ? "textual —— 必须给出摘要中逐字出现的 quote;给不出就不要判这条"
          : "structural —— 可用引用记录、年份、主题等结构事实,evidence 可为空";
      return `### ${index + 1}. ${preset.id} · ${preset.label} / ${preset.labelEn}
方向:${direction}
证据:${evidence}
判定标准:
${preset.definition}
反例(出现以下情况必须不判):
${preset.negativeExamples}`;
    })
    .join("\n\n");
}

function multiLabelUserPrompt(items: MultiPreparedPair[], taxonomy: RelationPreset[]): string {
  const blocks = items.map((item, index) => {
    const citation =
      item.citation === "none"
        ? "两者之间没有引用关系"
        : item.citation === "mutual"
          ? "两篇互相引用;方向仍按 B 引用 A 描述"
          : "存在引用;方向:B 引用了 A";
    const eligible = item.eligible.map((preset) => preset.id).join(", ");
    return `[${index + 1}]
可判关系:${eligible}
客观事实:${citation};年份差 ${item.f.yearGap} 年;共享主题 ${
      item.f.sharedTopics.length ? item.f.sharedTopics.join(", ") : "(无)"
    }
A) ${item.a.id} · ${item.a.year} · ${item.a.title}
   摘要: ${(item.a.abstract ?? "(无摘要)").slice(0, ABSTRACT_CHARS)}
B) ${item.b.id} · ${item.b.year} · ${item.b.title}
   摘要: ${(item.b.abstract ?? "(无摘要)").slice(0, ABSTRACT_CHARS)}`;
  });

  return `## 关系清单
${multiLabelTaxonomy(taxonomy)}

## 待判定 ${items.length} 对
${blocks.join("\n\n")}

逐对返回所有成立的关系;没有成立的关系时 labels 为空数组。每对都必须出现在 results 里。`;
}

/**
 * 模型输出归一化。三个不可省的检查:
 *   - relationId 必须在这一对的可判集合里(防止模型跨对套用 rubric);
 *   - 同一关系只保留 confidence 最高的一条;
 *   - evidence 形状不对的直接丢掉,后面还会再和原文做子串核验。
 */
export function normalizeMultiLabels(
  raw: MultiLabelCandidate[],
  eligible: RelationPreset[],
): MultiLabelVerdict[] {
  const allowed = new Map(eligible.map((preset, index) => [preset.id, index] as const));
  const best = new Map<string, MultiLabelVerdict>();

  for (const label of raw) {
    const order = allowed.get(label.relationId);
    if (order === undefined) continue;
    const confidence = Number.isFinite(label.confidence)
      ? Math.max(0, Math.min(1, label.confidence ?? 0.7))
      : 0.7;
    const previous = best.get(label.relationId);
    if (previous && previous.confidence >= confidence) continue;
    best.set(label.relationId, {
      relationId: label.relationId,
      match: true,
      confidence,
      rationale: label.rationale?.trim() || "模型判定该关系成立",
      evidence: (label.evidence ?? []).filter(
        (item) => item && typeof item.paperId === "string" && typeof item.quote === "string",
      ),
    });
  }

  return [...best.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (allowed.get(a.relationId) ?? 0) - (allowed.get(b.relationId) ?? 0);
  });
}

export interface RelationPipelineOptions {
  /** 当前账号:关系判定用这个账号绑定的模型。 */
  ownerId: string;
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
  /**
   * 一次建图最多送审多少**论文对**。
   *
   * 多标签判定的成本单位是论文对,不是「关系 × 论文对」:同一对论文
   * 无论能判几条关系都只调用一次。这里因此单独设一个全局上限,
   * 默认按每个关系的旧上限折算成两倍 —— 一次请求带回多条关系,
   * 同样的预算能覆盖更大的候选面。
   */
  maxPairs?: number;
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
  /**
   * 已经判过的论文对(键为 `${i}|${j}`,与方向无关)。传递扩展用它去重:
   * 第二轮的中心集合包含第一轮的全部成员,不排掉旧对的话,
   * 排在前面的永远是同一批人,新的一轮什么也长不出来。
   */
  skipPairs?: ReadonlySet<string>;
  /**
   * 每判定完一批就回调一次。流式返回靠它把结论逐条推给前端,
   * 顺带也让"判定到哪一步了"能被观测到。
   */
  onEdges?: (edges: GraphEdge[]) => void;
  onProgress?: (msg: string) => void;
}

export async function buildSemanticEdges(
  papers: OaWork[],
  opts: RelationPipelineOptions,
): Promise<{ edges: GraphEdge[]; report: RelationReport }> {
  const {
    ownerId,
    presets,
    candidateLimit = 40,
    maxJudgedPerPreset = 12,
    maxPairs,
    seedOaIds = [],
    centerOaIds = seedOaIds,
    skipPairs,
    onEdges,
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
  const useLlm = await llmAvailable(ownerId, "relation");
  const mode: "llm" | "heuristic" = useLlm ? "llm" : "heuristic";

  const edges: GraphEdge[] = [];
  const report: RelationReport = {
    perPreset: {},
    rejectedQuotes: 0,
    llmCalls: 0,
    estimatedTokens: 0,
    cacheHits: 0,
    batchFallbacks: 0,
    judgedPairs: [],
  };
  const perSeedCount = new Map<string, number>();
  const seedSet = new Set(seedOaIds);
  const enabled = presets.filter((preset) => preset.enabled);
  const pairBudget = Math.max(1, maxPairs ?? Math.max(16, maxJudgedPerPreset * 2));

  for (const preset of enabled) {
    report.perPreset[preset.id] = { candidates: 0, judged: 0, matched: 0, mode };
  }

  /**
   * 候选合并:同一对论文只保留一条记录,把能判的关系挂在它下面。
   *
   * 这是多标签判定的入口。旧实现按关系分头跑,一对论文被「基线」「扩展」
   * 「思路类似」各审一次 —— 同样的两段摘要读三遍,提示词里的 rubric 也重复三遍。
   * 合并后,一次调用即可返回所有成立的关系,冲突与重叠交给模型在同一上下文里处理。
   */
  const merged = new Map<string, MultiPreparedPair>();

  for (const preset of enabled) {

    /**
     * 有模型就全部交给模型。
     *
     * 这里一度把「结论矛盾」排除在模型判定之外 —— 理由是它的启发式打分恒为 0。
     * 但那正好把因果搞反了:矛盾关系恰恰是**唯一必须读摘要才能判断**的关系,
     * 元数据里根本没有它的信号。排除它的结果就是这一类边永远为空。
     */
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
      .filter((f) => {
        if (!skipPairs?.size) return true;
        return !skipPairs.has(pairKeyOf(f, papers));
      })
      .map((f) => ({ f, s: heuristicScore(f, preset) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, candidateLimit);

    for (const { f, s } of ranked) {
      const a = papers[f.i];
      const b = papers[f.j];
      if (!a || !b) continue;

      const pairKey = pairKeyOf(f, papers);
      let item = merged.get(pairKey);
      if (!item) {
        /**
         * 有向关系的**方向必须按引用来定,不能按下标定**。
         *
         * 候选对是按节点下标 (i < j) 生成的,下标顺序与时间顺序无关。
         * 「基线」的定义是「A 是 B 的基线」,如果 A/B 顺序随机,
         * 一半的候选就是反的 —— 一个严谨的模型会如实判为不成立。
         * 实测表现就是候选有几百条、judged 也有十几条,但 matched 恒为 0。
         */
        const oriented = orientPair(f, a, b);
        item = {
          f,
          a: oriented.a,
          b: oriented.b,
          eligible: [],
          score: s,
          scoreByPreset: new Map(),
          pairKey,
          citation:
            f.citesIJ && f.citesJI ? "mutual" : f.citesIJ || f.citesJI ? "b-cites-a" : "none",
        };
        merged.set(pairKey, item);
      }

      // 同一指数级候选可能在多个关系的候选集里出现;关系只挂一次
      if (!item.eligible.some((p) => p.id === preset.id)) item.eligible.push(preset);
      item.scoreByPreset.set(preset.id, s);
      if (s > item.score) item.score = s;
    }
  }

  const prepared = [...merged.values()]
    .sort((a, b) => b.score - a.score || b.eligible.length - a.eligible.length)
    .slice(0, pairBudget);

  for (const item of prepared) {
    report.judgedPairs.push(item.pairKey);
    if (mode !== "llm") continue;
    // 每对论文只调用一次,但每个参与判定的关系都记为「看过这一对」
    for (const preset of item.eligible) report.perPreset[preset.id]!.judged++;
  }

  const chunkSize = MULTI_BATCH * JUDGE_CONCURRENCY;
  let cursor = 0;

  while (cursor < prepared.length) {
    const chunk = prepared.slice(cursor, cursor + chunkSize);
    cursor += chunk.length;
    if (!chunk.length) break;

    const batchEdges: GraphEdge[] = [];

    // ---- 无模型:本地启发式,一次算完 ----
    if (mode === "heuristic") {
      for (const item of chunk) {
        for (const preset of item.eligible) {
          const score = item.scoreByPreset.get(preset.id) ?? 0;
          const quotaKey = quotaKeyOf(preset, item, seedSet);
          if (report.perPreset[preset.id]!.matched >= preset.maxPerSeed) continue;
          if ((perSeedCount.get(quotaKey) ?? 0) >= preset.maxPerSeed) continue;

          const edge = heuristicEdge(preset, item, score, report);
          if (!edge) continue;

          edges.push(edge);
          perSeedCount.set(quotaKey, (perSeedCount.get(quotaKey) ?? 0) + 1);
          report.perPreset[preset.id]!.matched++;
        }
      }
      continue;
    }

    // ---- 有模型:逐关系查缓存,只把缺失的关系送审 ----
    const cachedByIndex = new Map<number, MultiLabelVerdict[]>();
    const freshByIndex = new Map<number, MultiLabelVerdict[]>();
    const missingByIndex = new Map<number, RelationPreset[]>();
    const pending: number[] = [];

    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      if (!item) continue;

      const cachedLabels: MultiLabelVerdict[] = [];
      const missing: RelationPreset[] = [];
      for (const preset of item.eligible) {
        const { hit, verdict } = await readLabel(item.pairKey, preset);
        if (!hit) {
          missing.push(preset);
          continue;
        }
        if (verdict) cachedLabels.push(verdict);
      }

      if (cachedLabels.length) cachedByIndex.set(i, cachedLabels);
      if (!missing.length) {
        // 整对都命中缓存,这一对不会再产生模型调用
        report.cacheHits++;
        continue;
      }
      missingByIndex.set(i, missing);
      pending.push(i);
    }

    // ---- 分批送审,批间并发 ----
    const batches = chunkIndexes(pending, MULTI_BATCH);
    await runConcurrent(batches, JUDGE_CONCURRENCY, async (batch) => {
      const items: MultiPreparedPair[] = [];
      const indexes: number[] = [];
      for (const i of batch) {
        const item = chunk[i];
        const missing = missingByIndex.get(i);
        if (!item || !missing?.length) continue;
        // 只送这一对里尚未命中的关系:改一条 rubric 不会连带重判其它标签
        items.push({ ...item, eligible: missing });
        indexes.push(i);
      }
      if (!items.length) return;

      const got = await judgeMultiBatch(ownerId, items, taxonomyOf(items), report);
      if (!got) {
        // 整批解析失败:退回逐对判定,多花几次调用也不丢结论
        report.batchFallbacks++;
        for (let k = 0; k < items.length; k++) {
          const item = items[k];
          const index = indexes[k];
          if (!item || index === undefined) continue;
          const single = await judgeMultiPair(ownerId, item, report);
          if (single !== null) freshByIndex.set(index, single);
        }
        return;
      }

      let missing = false;
      for (let k = 0; k < items.length; k++) {
        const item = items[k];
        const index = indexes[k];
        if (!item || index === undefined) continue;
        const labels = got.get(k);
        if (labels) {
          freshByIndex.set(index, labels);
          continue;
        }
        // 批里漏掉一对:其余结论保留,这一对单独补判
        missing = true;
        const single = await judgeMultiPair(ownerId, item, report);
        if (single !== null) freshByIndex.set(index, single);
      }
      if (missing) report.batchFallbacks++;
    });

    // ---- 回写缓存并落边 ----
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      if (!item) continue;

      const missing = missingByIndex.get(i);
      const fresh = freshByIndex.get(i);
      if (missing && fresh) {
        // 否定结论也逐关系落盘:这一对下次只剩未成立的关系时,依然零调用
        for (const preset of missing) {
          const verdict = fresh.find((label) => label.relationId === preset.id) ?? null;
          await writeLabel(item.pairKey, preset, verdict);
        }
      }

      const labels = normalizeMultiLabels(
        [...(cachedByIndex.get(i) ?? []), ...(fresh ?? [])],
        item.eligible,
      );
      if (!labels.length) continue;

      for (const verdict of labels) {
        const preset = item.eligible.find((p) => p.id === verdict.relationId);
        if (!preset) continue;

        // 每篇种子与每个预设的配额:防止高产关系淹没整张图
        const quotaKey = quotaKeyOf(preset, item, seedSet);
        if (report.perPreset[preset.id]!.matched >= preset.maxPerSeed) continue;
        if ((perSeedCount.get(quotaKey) ?? 0) >= preset.maxPerSeed) continue;

        const edge = judgementToEdge(preset, item, verdict, report);
        if (!edge) continue;

        edges.push(edge);
        batchEdges.push(edge);
        perSeedCount.set(quotaKey, (perSeedCount.get(quotaKey) ?? 0) + 1);
        report.perPreset[preset.id]!.matched++;
      }
    }

    // 一批判完就把它推出去 —— 流式返回靠这个"边判边亮"
    if (batchEdges.length) onEdges?.(batchEdges);
  }

  return { edges, report };
}

/** 一批待判对里出现的关系清单,只渲染这一批真正用得上的 rubric。 */
function taxonomyOf(items: MultiPreparedPair[]): RelationPreset[] {
  const seen = new Map<string, RelationPreset>();
  for (const item of items) {
    for (const preset of item.eligible) {
      if (!seen.has(preset.id)) seen.set(preset.id, preset);
    }
  }
  return [...seen.values()];
}

/** 配额键按「关系 + 种子」计。没有种子参与时退回 A 的 id,保证同一对论文稳定。 */
function quotaKeyOf(
  preset: RelationPreset,
  item: MultiPreparedPair,
  seedSet: ReadonlySet<string>,
): string {
  const subject = seedSet.has(item.b.id) ? item.b.id : item.a.id;
  return `${preset.id}:${subject}`;
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

interface CachedRelationLabel {
  relationId: string;
  /** false 是「判过,但不成立」。否定结论同样要缓存,否则每轮都会重问。 */
  match: boolean;
  confidence?: number | null;
  rationale?: string | null;
  evidence?: Array<{ paperId: string; quote: string }> | null;
}

/**
 * 缓存键 = 无序论文对 + 关系 id + 该关系的 promptVersion。
 *
 * 粒度必须落到关系,不能落到论文对:一对论文可能同时命中「基线」与「扩展」,
 * 用户只改了其中一条的 rubric,另一条的旧结论仍然有效 —— 整对作废会白白重付一次调用。
 */
function labelCacheKey(pairKey: string, preset: RelationPreset): string {
  // 系统提示词也是判定口径的一部分。它变化时必须让旧结论失效,
  // 否则之前缓存下来的 match:false 会永久压住新口径。
  return `${pairKey}|${preset.id}|${preset.promptVersion}|multi@2`;
}

async function readLabel(
  pairKey: string,
  preset: RelationPreset,
): Promise<{ hit: boolean; verdict: MultiLabelVerdict | null }> {
  const cached = await readCache<CachedRelationLabel>(
    "relation-labels",
    labelCacheKey(pairKey, preset),
  );
  if (!cached) return { hit: false, verdict: null };
  // 形状不对的旧载荷按未命中处理,不能把损坏的缓存当成「不成立」
  if (cached.relationId !== preset.id || typeof cached.match !== "boolean") {
    return { hit: false, verdict: null };
  }
  if (cached.match !== true) return { hit: true, verdict: null };
  // 缓存是外部输入:旧版本可能塞进未知 relationId,读出来仍要过白名单
  const [verdict] = normalizeMultiLabels([cached], [preset]);
  return verdict ? { hit: true, verdict } : { hit: false, verdict: null };
}

function writeLabel(
  pairKey: string,
  preset: RelationPreset,
  verdict: MultiLabelVerdict | null,
): Promise<boolean> {
  const payload: CachedRelationLabel = verdict
    ? {
        relationId: verdict.relationId,
        match: true,
        confidence: verdict.confidence,
        rationale: verdict.rationale,
        evidence: verdict.evidence,
      }
    : { relationId: preset.id, match: false };
  return writeCache("relation-labels", labelCacheKey(pairKey, preset), payload);
}

/**
 * 多标签批量送审。
 *
 * 返回 null 表示整批不可用(网络失败或输出完全不合规),由调用方退回逐对判定。
 * 返回空 Map 永远不会发生 —— 只要模型给出了任意一对的结果,其余缺失的由调用方补判。
 */
async function judgeMultiBatch(
  ownerId: string,
  items: MultiPreparedPair[],
  taxonomy: RelationPreset[],
  report: RelationReport,
): Promise<Map<number, MultiLabelVerdict[]> | null> {
  if (!items.length) return new Map();

  const system = multiLabelSystem();
  const user = multiLabelUserPrompt(items, taxonomy);
  report.llmCalls++;
  report.estimatedTokens += Math.ceil((system.length + user.length) / 2.4);

  const res = await chatJson(
    { ownerId, system, user, temperature: 0.05, maxTokens: 4600 },
    MultiBatchSchema,
  );
  if (!res) return null;

  const out = new Map<number, MultiLabelVerdict[]>();
  for (const result of res.value.results) {
    const index = result.index - 1;
    const item = items[index];
    if (!item) continue;
    out.set(index, normalizeMultiLabels(result.labels ?? [], item.eligible));
  }
  return out.size ? out : null;
}

/** 单对兜底。仍走多标签 schema —— 兜底不该顺手降级成「一对只能出一条关系」。 */
async function judgeMultiPair(
  ownerId: string,
  item: MultiPreparedPair,
  report: RelationReport,
): Promise<MultiLabelVerdict[] | null> {
  const system = multiLabelSystem();
  const user = multiLabelUserPrompt([item], item.eligible);
  report.llmCalls++;
  report.estimatedTokens += Math.ceil((system.length + user.length) / 2.4);

  // 系统提示词统一要求 results 结构,单对兜底也走同一个 schema,避免出口不一致
  const res = await chatJson(
    { ownerId, system, user, temperature: 0.05, maxTokens: 1800 },
    MultiBatchSchema,
  );
  if (!res) return null;
  const result = res.value.results.find((entry) => entry.index === 1) ?? res.value.results[0];
  if (!result) return null;
  return normalizeMultiLabels(result.labels ?? [], item.eligible);
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
  p: MultiPreparedPair,
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
    evidence = [structuralEvidence(p.f, p.a, p.b, p.citation)];
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
  p: MultiPreparedPair,
  score: number,
  report: RelationReport,
): GraphEdge | null {
  void report;
  if (preset.id === "contradicts") return null; // 没有模型就诚实地不给结论
  if (score < 0.55) return null;

  return makeEdge(
    preset,
    p.a,
    p.b,
    score,
    [
      {
        kind: "metadata",
        note: `引用关系:${
          p.citation === "none" ? "无" : p.citation === "mutual" ? "互相引用" : "B→A"
        };共享主题 ${p.f.sharedTopics.length} 个;标题相似度 ${(p.f.titleSim * 100).toFixed(0)}%`,
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
