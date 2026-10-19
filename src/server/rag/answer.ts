/**
 * 回答层 —— 检索结果 → 带角标的回答。
 *
 * 三条硬约束:
 *   1. 资料是首选证据;资料之外的通用知识可以补全,但必须单独标注;
 *   2. 来自资料的事实带 [n] 角标,n 指向检索到的块;通用知识不加角标;
 *   3. 模型不可用时给出"纯检索摘录"作为降级答案,而不是空白或编造。
 */

import type { RetrievedSource } from "./retrieve";
import { z } from "zod";

import { chatJson } from "../llm/client";
import type { AskSuggestion } from "@/types/rag";

export const ASK_SYSTEM = `你是「StellarLit 星图」的文献问答助手。资料是你的证据底座,不是你的知识上限。

规则:
1. 先依据 <资料> 回答;这是最可靠的证据。
2. 资料没覆盖的部分,**用你自己的通用知识补全**——你连接的是大模型,RAG 只是辅助,
   不要拒绝回答,也不要写"资料未覆盖…/资料不足…/只能回答…"这类话。
3. 区分来源:来自资料的结论带 [n] 角标;通用知识放在回答最后,以
   "补充(通用知识):"开头,不要加角标;不确定的细节用"通常""据我所知"限定。
4. 第一句必须是答案本身,不要用范围声明开头。
5. 来自资料的每个事实性结论后面用 [n] 标注来源;多个来源写成 [1][3]。
6. 不要编造资料编号;通用知识部分不能伪装成资料引用。
7. 用中文。总长不超过 300 字。
8. 关系类问题优先使用"关系证据"块,并说明证据来自原文还是引文记录。
9. 输出纯文本:不要使用 **、# 标题、表格等 Markdown 语法;需要列举时用「- 」开头。`;

const SuggestionSchema = z.object({
  papers: z
    .array(
      z.object({
        title: z.string(),
        year: z.number().optional(),
        reason: z.string().optional(),
      }),
    )
    .max(4),
});

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();

/**
 * 从回答里抽出"被提到、但星空里还没有"的论文。
 *
 * 交给模型整理而不是用正则扫标题:回答是自然语言,论文名可能带版本号、
 * 缩写或中文译名;让模型按 JSON 输出再过滤,比字符串匹配稳得多。
 * 只返回**确有可能存在**的论文,最终是否加入仍由用户确认。
 */
export async function extractSuggestions(
  question: string,
  answer: string,
  existingTitles: string[],
): Promise<AskSuggestion[]> {
  const res = await chatJson(
    {
      system: `你是学术文献整理助手。从回答里找出被提到、但不在「已有论文」列表中的论文。
只输出 JSON:{"papers":[{"title":"...","year":2019,"reason":"为什么相关"}]}
规则:最多 4 篇;只列你确信真实存在的论文;标题用正式英文名;不要重复已有论文。
如果回答里没有新论文,输出 {"papers":[]}。`,
      user: `## 已有论文
${existingTitles.join("\n")}

## 回答
${answer}

## 用户问题
${question}`,
      temperature: 0.1,
      maxTokens: 500,
    },
    SuggestionSchema,
  );
  if (!res) return [];

  const existing = existingTitles.map(norm);
  return res.value.papers
    .filter((p) => p.title.trim().length > 6)
    .filter((p) => {
      const t = norm(p.title);
      return !existing.some((e) => e === t || e.includes(t) || t.includes(e));
    })
    .slice(0, 4);
}

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
    return "这片星空里暂时没有可检索的资料。先在顶部输入一篇种子论文,再问一次。";
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
