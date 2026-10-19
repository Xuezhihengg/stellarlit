/** RAG 问答的请求与流式事件。前后端共用,避免两边各写一份形状。 */

export interface AskRequest {
  starfieldId: string;
  question: string;
}

export interface AskSource {
  /** 回答里的角标编号,从 1 开始 */
  n: number;
  chunkId: string;
  paperId: string;
  paperIds: string[];
  title: string;
  section: "title" | "abstract" | "relation";
  year?: number;
  /** 证据摘录 */
  quote: string;
}

/** 回答里提到、但当前星空还没有的论文;是否加入由用户确认。 */
export interface AskSuggestion {
  title: string;
  year?: number;
  reason?: string;
}

export type AskEvent =
  | { type: "sources"; sources: AskSource[] }
  | { type: "delta"; text: string }
  | {
      type: "done";
      citations: number[];
      fallback?: boolean;
      suggestions?: AskSuggestion[];
    }
  | { type: "error"; message: string };
