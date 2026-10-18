/**
 * 关系类型的中文名 —— 图、详情面板、RAG 语料共用一份。
 *
 * 之前这张表在详情面板里有一份、RAG 语料又想再写一份。两处各写一张,
 * 迟早会出现"面板写基线、回答里写 BASELINE_OF"的割裂。
 */

export const EDGE_KIND_LABEL: Record<string, string> = {
  CITES: "引用",
  BASELINE_OF: "基线",
  CONTEMPORARY_OF: "同期",
  SIMILAR_APPROACH: "思路类似",
  ALTERNATIVE_TO: "同任务异方法",
  EXTENDS: "扩展",
  CONTRADICTS: "结论矛盾",
  MENTIONS: "提及",
  SEMANTIC_NEIGHBOR: "语义近邻",
  POTENTIAL_LINK: "潜在连接",
};

export function edgeKindLabel(kind: string): string {
  return EDGE_KIND_LABEL[kind] ?? kind;
}
