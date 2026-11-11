/**
 * 查询规划 —— 在召回之前把问题改写成几路互补的检索词。
 *
 * 这里刻意用确定性规则而不是再调一次模型:
 *   1. 问答链路已经有一次 Agent 规划,再加一次改写会把首字延迟推高;
 *   2. 模型不可用时,同义扩展与比较题拆解仍然必须工作;
 *   3. 规则可测试,能保证「同义表达」「三篇论文比较」这类场景不靠运气。
 *
 * 原始问题永远排第一路;改写只负责补召回,不会覆盖用户原话。
 */

import type { StarfieldPayload } from "@/types/api";
import type { PaperNode } from "@/types/kg";

export type QueryIntent = "general" | "relation" | "comparison" | "external";

export interface QueryVariant {
  text: string;
  kind: "original" | "rewrite" | "subquestion" | "relation";
  weight: number;
}

export interface QueryPlan {
  original: string;
  intent: QueryIntent;
  variants: QueryVariant[];
  mentionedPaperIds: string[];
  comparison: boolean;
}

const COMPARISON_CUES = /比较|对比|区别|差异|相比|不同路线|\bvs\.?\b|\bcompare|comparison|difference/i;
const RELATION_CUES = /关系|基线|区别|差异|比较|对比|谁引用|引用谁|沿用|继承|改进|baseline|relation|cite/i;
const EXTERNAL_CUES = /后来|后续|还有哪些|哪些工作|扩展|引用它|谁用了|谁引用|被谁引用|谁沿用了|沿用了它|follow-?up|later work/i;

/** 同义组只做「看到左边就补右边」,不反向污染用户原句。 */
const SYNONYM_GROUPS: Array<{ cues: RegExp; expansion: string }> = [
  { cues: /基线|基准/, expansion: "baseline benchmark" },
  { cues: /区别|差异|对比|比较/, expansion: "difference comparison alternative" },
  { cues: /改进|提升|优化/, expansion: "improvement improved extension" },
  { cues: /沿用|继承|后续|后来/, expansion: "follow-up extension later work" },
  { cues: /同任务|不同路线|同类/, expansion: "same task different approach" },
  { cues: /方法|路线|架构/, expansion: "method approach architecture" },
  { cues: /关系/, expansion: "relation evidence" },
  { cues: /引用|被引/, expansion: "citation cited" },
  { cues: /多阶段|两阶段/, expansion: "two-stage multi-stage" },
  { cues: /单阶段/, expansion: "one-stage single-stage" },
  { cues: /检测器|检测模型/, expansion: "detector detection model" },
  { cues: /对抗生成|生成对抗/, expansion: "gan generative adversarial network" },
];

function normText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** 论文的全名、冒号前短名与首字母缩写都算「被提到」。 */
function aliasesOf(title: string): string[] {
  const short = title.split(":")[0]?.trim() ?? title;
  const words = (value: string) => value.split(/[^A-Za-z0-9]+/).filter((word) => word.length >= 2);
  const acronym = (value: string) => words(value).map((word) => word[0]).join("");
  return [title, short, acronym(title), acronym(short)]
    .map(normText)
    .filter((alias) => alias.length >= 3);
}

export function findMentionedPapers(papers: PaperNode[], question: string): PaperNode[] {
  const q = normText(question);
  return papers.filter((paper) => aliasesOf(paper.title).some((alias) => q.includes(alias)));
}

function uniqueVariants(variants: QueryVariant[]): QueryVariant[] {
  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = variant.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 把「比较 A、B、C」拆成每篇论文一个子问题,再加一条共同任务的对比较。 */
function subquestionsFor(question: string, papers: PaperNode[]): QueryVariant[] {
  const out: QueryVariant[] = [];
  for (const paper of papers.slice(0, 4)) {
    out.push({
      text: `${paper.title} 方法 贡献 结果 benchmark method contribution result`,
      kind: "subquestion",
      weight: 0.82,
    });
  }
  if (papers.length >= 2) {
    const allTitles = papers
      .slice(0, 4)
      .map((paper) => paper.title)
      .join(" ");
    out.push({
      text: `${allTitles} 共同任务 不同路线 对比 relation comparison same task different approach`,
      kind: "relation",
      weight: 1.05,
    });
  }
  if (!papers.length) {
    out.push({ text: `${question} same task different approach comparison`, kind: "rewrite", weight: 0.55 });
  }
  return out;
}

export function buildQueryPlan(payload: StarfieldPayload, question: string): QueryPlan {
  const papers = payload.graph.nodes.filter((node): node is PaperNode => node.kind === "paper");
  const mentioned = findMentionedPapers(papers, question).slice(0, 4);
  const comparison = COMPARISON_CUES.test(question);
  const relation = RELATION_CUES.test(question);
  const external = EXTERNAL_CUES.test(question);
  const intent: QueryIntent = comparison
    ? "comparison"
    : relation
      ? "relation"
      : external
        ? "external"
        : "general";

  const expansions = SYNONYM_GROUPS.filter((group) => group.cues.test(question)).map(
    (group) => group.expansion,
  );
  const variants: QueryVariant[] = [{ text: question, kind: "original", weight: 1 }];

  if (expansions.length) {
    variants.push({ text: `${question} ${expansions.join(" ")}`, kind: "rewrite", weight: 0.62 });
  }

  if (comparison) {
    variants.push(...subquestionsFor(question, mentioned));
  } else if (relation && mentioned.length >= 2) {
    variants.push({
      text: `${mentioned.map((paper) => paper.title).join(" ")} 关系 证据 对比 relation evidence difference`,
      kind: "relation",
      weight: 0.9,
    });
  }

  return {
    original: question,
    intent,
    variants: uniqueVariants(variants).slice(0, 6),
    mentionedPaperIds: mentioned.map((paper) => paper.id),
    comparison,
  };
}
