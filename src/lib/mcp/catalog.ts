/**
 * MCP 工具目录的前端副本。
 *
 * 这里只放「给人看」的元信息(名字、一句话作用),给设置页列清单用。
 * 真正的 schema 与实现在 `src/server/mcp/tools.ts` —— 浏览器包不能引用 server/。
 * 两边是否会漂移由 `scripts/check-mcp.ts` 兜住:它会把这份目录和 tools/list
 * 的真实返回逐条比对,少一个工具就报错。
 */

export const MCP_SERVER_NAME = "stellarlit-starfield";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_INSTRUCTIONS =
  "StellarLit 的论文星空工具集。先调 list_starfields 拿到 starfieldId;回答「这片星空里怎么说」先调 search_starfield 拿 chunkId;解释两篇论文的关系调 find_relation_evidence;补文献调 search_papers。所有工具只读,不会改动用户已保存的星空。";

export interface McpToolInfo {
  name: string;
  title: string;
  note: string;
  /** 是否会访问外部网络(OpenAlex / arXiv)。 */
  openWorld: boolean;
}

export const MCP_TOOLS: McpToolInfo[] = [
  {
    name: "list_starfields",
    title: "列出星空",
    note: "列出星空,拿到 starfieldId",
    openWorld: false,
  },
  {
    name: "get_starfield",
    title: "读星空结构",
    note: "规模、关系分布、论文清单",
    openWorld: false,
  },
  {
    name: "search_starfield",
    title: "检索原文",
    note: "BM25 + 向量 RRF + 图扩展,返回可核引摘录",
    openWorld: false,
  },
  {
    name: "find_relation_evidence",
    title: "查关系证据",
    note: "已判定的语义关系与原文证据",
    openWorld: false,
  },
  {
    name: "get_paper_context",
    title: "读论文上下文",
    note: "摘要 + 全部关系边",
    openWorld: false,
  },
  {
    name: "expand_citations",
    title: "展开引文邻域",
    note: "参考文献 / 引用它的工作",
    openWorld: true,
  },
  {
    name: "get_paper",
    title: "精确查一篇",
    note: "按 id / DOI / 标题查元数据",
    openWorld: true,
  },
  {
    name: "search_papers",
    title: "主题检索",
    note: "按主题与年份找外部文献",
    openWorld: true,
  },
  {
    name: "resolve_seed",
    title: "解析种子候选",
    note: "只返回种子候选,不改图",
    openWorld: true,
  },
];

/** Cursor / 任意 Streamable HTTP 客户端可直接粘贴的配置。 */
export function httpClientConfig(origin: string, token?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          url: `${origin.replace(/\/$/, "")}/api/mcp`,
          headers: { Authorization: `Bearer ${token ?? "<YOUR_MCP_TOKEN>"}` },
        },
      },
    },
    null,
    2,
  );
}

/** Claude Code 的一行接入命令。 */
export function claudeCodeCommand(origin: string, token?: string): string {
  const value = token ?? "<YOUR_MCP_TOKEN>";
  return `claude mcp add --transport http --header "Authorization: Bearer ${value}" ${MCP_SERVER_NAME} ${origin.replace(/\/$/, "")}/api/mcp`;
}
