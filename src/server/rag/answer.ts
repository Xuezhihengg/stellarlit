/**
 * 回答层 —— 检索结果 → 带角标的回答。
 *
 * 三条硬约束:
 *   1. 只能依据给定资料,资料不足要明确承认;
 *   2. 每个事实性结论都要带 [n] 角标,n 指向检索到的块;
 *   3. 模型不可用时给出"纯检索摘录"作为降级答案,而不是空白或编造。
 */

import type { RetrievedSource } from "./retrieve";

export const ASK_SYSTEM = `你是「StellarLit 星图」的文献问答助手。只能依据 <资料> 中给出的内容回答。

规则:
1. 不得引入资料以外的知识。资料不足以回答时,明确说"现有资料不足以回答",并说明缺什么。
2. 每个事实性结论后面用 [n] 标注来源,n 是资料编号;多个来源写成 [1][3]。
3. 不要编造资料编号,不要引用没有给出的论文。
4. 用中文。先给结论(一两句),再给依据(最多四条),总长不超过 260 字。
5. 关系类问题优先使用"关系证据"块,并说明证据来自原文还是引文记录。`;

const SECTION_LABEL: Record<string, string> = {
  title: "论文信息",
  abstract: "摘要",
  relation: "关系证据",
};

export function buildAskPrompt(question: string, sources: RetrievedSource[]): string {
  const blocks = sources.map((s, i) => {
    const meta = [
      `《${s.title}》`,
      s.year ? `${s.year}` : "",
      SECTION_LABEL[s.section] ?? s.section,
    ]
      .filter(Boolean)
      .join(" · ");
    return `[${i + 1}] ${meta}\n${s.text.slice(0, 700)}`;
  });

  return `<资料>
${blocks.join("\n\n")}
</资料>

问题:${question}`;
}

/** 模型不可用时的降级答案:只列检索到的原文,不做推断。 */
export function extractiveAnswer(sources: RetrievedSource[]): string {
  if (!sources.length) {
    return "这片星空里暂时没有可检索的资料。先落入一篇种子论文,再问一次。";
  }
  const lines = sources.slice(0, 4).map((s, i) => {
    const where = SECTION_LABEL[s.section] ?? s.section;
    return `[${i + 1}] 《${s.title}》· ${where}:${s.quote.replace(/\s+/g, " ")}`;
  });
  return `模型暂不可用,先给出检索到的原文依据,不作推断:\n${lines.join("\n")}`;
}

/** 从回答里抽出引用编号,只保留实际存在的来源。 */
export function citedNumbers(answer: string, count: number): number[] {
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[([0-9,\s]+)\]/g)) {
    for (const piece of (match[1] ?? "").split(",")) {
      const n = Number.parseInt(piece.trim(), 10);
      if (Number.isFinite(n) && n >= 1 && n <= count) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}
