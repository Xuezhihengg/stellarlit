/**
 * 内置关系预设。
 *
 * 这些对象是**数据**,不是代码分支。设置页可以修改它们的判定标准与反例,
 * 判定管道只负责把 definition / negativeExamples 注入提示词。
 *
 * 为什么要给反例:只给正例是幻觉的主要来源。模型不知道边界在哪,
 * 就会把所有「看起来差不多」的论文对判成同一种关系 ——
 * 而「同期」与「思路类似」这两类恰恰最容易互相污染。
 */

import type { RelationPreset } from "@/types/kg";

export const BUILTIN_PRESETS: RelationPreset[] = [
  {
    id: "baseline",
    label: "基线",
    labelEn: "Baseline",
    description: "前者是该方向公认的基线方法,后者以它为对照并试图超越。",
    definition:
      "判定 A 是 B 的基线:应同时满足 —— ① B 明确把 A 作为对比对象或出发点;" +
      "② A 在同一任务上提出了一个被广泛沿用的做法;③ 时序上 A 早于 B 或与之同期。" +
      "典型句式:「We compare against …」「Following the setup of …」。",
    negativeExamples:
      "A 只是被 B 顺带引用(出现在相关工作列表里)不算;" +
      "A 与 B 解决的是不同任务、只是用了同一个数据集,不算;" +
      "B 引用了 A 但只是复用了 A 的某一个组件,不算基线关系。",
    directed: true,
    hardConstraints: {
      requireCitation: true,
      maxYearGap: 8,
    },
    evidencePolicy: "structural",
    visual: { tone: "var(--ink-2)", dash: "none" },
    promptVersion: "baseline@1",
    enabled: true,
    maxPerSeed: 6,
    builtin: true,
  },
  {
    id: "contemporary",
    label: "同期",
    labelEn: "Contemporary",
    description: "同一时期并行出现、解决相邻问题,但彼此没有互相引用。",
    definition:
      "判定 A 与 B 同期:① 发表年份相差不超过 2 年;② 面向相邻或相同的任务;" +
      "③ **两者之间没有引用关系**。第三条是这条关系存在的意义 ——" +
      "它标识的是「平行但未交汇」的工作。",
    negativeExamples:
      "两者之间有任何一方的引用,都不算同期(那是基线或扩展);" +
      "年份相同但领域完全不同,不算;" +
      "只是撞名或撞关键词,不算。",
    directed: false,
    hardConstraints: {
      requireMutualNonCitation: true,
      maxYearGap: 2,
    },
    evidencePolicy: "structural",
    visual: { tone: "var(--ink-3)", dash: "2 6" },
    promptVersion: "contemporary@1",
    enabled: true,
    maxPerSeed: 8,
    builtin: true,
  },
  {
    id: "similar",
    label: "思路类似",
    labelEn: "Similar approach",
    description: "核心思路同源,可能是把同一种机制用在了不同任务上。",
    definition:
      "判定 A 与 B 思路类似:① 两者的核心机制(而非表面关键词)相同或高度同构;" +
      "② 允许任务不同、领域不同 —— 这正是这条关系有价值的地方:" +
      "同一个思路迁移到了别处,往往是可借鉴的信号。",
    negativeExamples:
      "只是共享了某个通用组件(如都用了 Transformer、都用了 Adam),不算;" +
      "只是同一个团队在同一方向上的连续工作,不算(那是扩展);" +
      "只是都用了同一个数据集,不算。",
    directed: false,
    hardConstraints: {
      /**
       * 走 TF-IDF 余弦。这类指标的绝对值天然偏低:两篇摘要即使讲同一件事,
       * 因为用词、句式不同,余弦通常也只在 0.2~0.4 之间。
       * 阈值定在 0.35 时实测把整类关系筛成了空集 —— 阈值要贴着指标的尺度定,
       * 而不是照着"感觉上应该像"的直觉定。
       */
      minSimilarity: 0.2,
    },
    evidencePolicy: "textual",
    visual: { tone: "var(--accent)", dash: "none" },
    promptVersion: "similar@1",
    enabled: true,
    maxPerSeed: 6,
    builtin: true,
  },
  {
    id: "alternative",
    label: "同任务异方法",
    labelEn: "Alternative method",
    description: "面向同一个任务,但技术路线明显不同。",
    definition:
      "判定 A 与 B 是同一任务的不同方法:① 两者解决的任务明确相同(可指向同一个 benchmark);" +
      "② 技术路线在方法论层面不同(不是同一方法的两个变体)。",
    negativeExamples:
      "同一个方法的两个微调版本,不算;" +
      "任务描述相似但实际评测的指标或数据集都不重叠,不算;" +
      "一个是综述、一个是方法论文,不算。",
    directed: false,
    hardConstraints: {
      requireSharedTask: true,
    },
    evidencePolicy: "textual",
    visual: { tone: "var(--warm)", dash: "none" },
    promptVersion: "alternative@1",
    enabled: true,
    maxPerSeed: 6,
    builtin: true,
  },
  {
    id: "extends",
    label: "扩展",
    labelEn: "Extends",
    description: "后者在前者的基础上做了直接改进。",
    definition:
      "判定 B 扩展 A:① B 明确声称改进或拓展了 A;② 有可指认的具体改动(新模块、新约束、新训练目标);" +
      "③ B 引用了 A。典型句式:「We extend …」「Building on …, we …」。",
    negativeExamples:
      "B 只是复现了 A 并在更多数据集上评测,不算扩展;" +
      "B 只是引用 A 作为背景,不算;" +
      "同一作者把 A 的工作换了个应用场景,不算扩展(那是新工作)。",
    directed: true,
    hardConstraints: {
      requireCitation: true,
      maxYearGap: 6,
    },
    evidencePolicy: "structural",
    visual: { tone: "var(--accent)", dash: "none" },
    promptVersion: "extends@1",
    enabled: true,
    maxPerSeed: 6,
    builtin: true,
  },
  {
    id: "contradicts",
    label: "结论矛盾",
    labelEn: "Contradicts",
    description: "在可比条件下得到相反结论的两篇工作。",
    definition:
      "判定 A 与 B 结论矛盾:① 两者针对同一个可比较的问题;" +
      "② 结论方向相反(一方报告某方法有效、另一方在同条件下报告无效或相反趋势);" +
      "③ 能指出具体的结论冲突点,而不是笼统的「看法不同」。",
    negativeExamples:
      "评测设置不同导致的差异(数据集、规模、指标不一致),不算矛盾 —— 那是不可比;" +
      "只是对未来方向的判断不同(观点分歧),不算结论矛盾;" +
      "一篇是方法论文、一篇是批判性综述,不算。",
    directed: false,
    hardConstraints: {
      maxYearGap: 6,
      requireSharedTask: true,
    },
    evidencePolicy: "textual",
    visual: { tone: "var(--alert)", dash: "none" },
    promptVersion: "contradicts@1",
    enabled: true,
    maxPerSeed: 3,
    builtin: true,
  },
];

export const PRESETS_BY_ID: Record<string, RelationPreset> = Object.fromEntries(
  BUILTIN_PRESETS.map((p) => [p.id, p]),
);

/** 关系预设 → 语义边的 kind。名字不同是因为边的 kind 是编译期常量,预设 id 可被用户扩展。 */
export const PRESET_TO_EDGE_KIND = {
  baseline: "BASELINE_OF",
  contemporary: "CONTEMPORARY_OF",
  similar: "SIMILAR_APPROACH",
  alternative: "ALTERNATIVE_TO",
  extends: "EXTENDS",
  contradicts: "CONTRADICTS",
} as const;

export type BuiltinPresetId = keyof typeof PRESET_TO_EDGE_KIND;

export function edgeKindOf(presetId: string): string {
  return PRESET_TO_EDGE_KIND[presetId as BuiltinPresetId] ?? presetId.toUpperCase();
}
