/**
 * stdio 入口:给 Claude Desktop / Cursor 这类本地 MCP 客户端用。
 *
 * 启动:`pnpm mcp`(或 `node --import tsx scripts/mcp-server.ts`)。
 * 注意 stdout 属于协议通道,日志一律走 stderr。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveMcpToken } from "../src/server/db/mcp-tokens";
import { createStarfieldMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../src/server/mcp/server";

async function main(): Promise<void> {
  // stdio 没有 Cookie,也不能猜「第一个账号」:用设置页生成的个人令牌明确身份
  const raw = process.env.STELLARLIT_MCP_TOKEN?.trim();
  if (!raw) {
    console.error("缺少 STELLARLIT_MCP_TOKEN。请先在设置 → MCP 工具中生成个人令牌。");
    process.exit(1);
  }
  const token = await resolveMcpToken(raw);
  if (!token) {
    console.error("STELLARLIT_MCP_TOKEN 无效或已被撤销。");
    process.exit(1);
  }

  const server = createStarfieldMcpServer(token.ownerId);
  await server.connect(new StdioServerTransport());
  console.error(`${MCP_SERVER_NAME} v${MCP_SERVER_VERSION} 已通过 stdio 就绪(账号 ${token.ownerId})`);
}

main().catch((error: unknown) => {
  console.error("MCP server 启动失败:", error);
  process.exit(1);
});
