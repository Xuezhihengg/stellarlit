/**
 * MCP 服务端工厂。
 *
 * 一次握手一个实例:HTTP 端点是无状态的,stdio 入口则长期持有同一个实例。
 * 工具注册集中在 `tools.ts`,这里只负责装配,方便「网页 API / 命令行 / 测试」
 * 三条入口共用同一份工具定义。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerStarfieldTools } from "./tools";

export const MCP_SERVER_NAME = "stellarlit-starfield";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_INSTRUCTIONS =
  "StellarLit 的论文星空工具集。先调 list_starfields 拿到 starfieldId;回答「这篇星空里怎么说」先调 search_starfield 拿 chunkId;解释两篇论文的关系调 find_relation_evidence;补文献调 search_papers。所有工具只读,不会改动用户已保存的星空。";

/**
 * ownerId 必须显式传入:站内 Agent 传当前会话,HTTP 入口传令牌绑定的账号,
 * stdio 入口从 STELLARLIT_MCP_TOKEN 解析。任何情况下都不读「第一个账号」。
 */
export function createStarfieldMcpServer(ownerId: string): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerStarfieldTools(server, ownerId);
  return server;
}
