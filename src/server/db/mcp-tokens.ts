/**
 * MCP 个人访问令牌。
 *
 * 外部 MCP 客户端没有 Cookie,不能拿「最早注册的账号」兜底 —— 那等于把
 * 第一个用户的数据公开给任何知道端点的人。每个令牌只绑定一个 owner,
 * 数据库里只存 SHA-256,原始令牌只在创建时返回一次。
 */

import { createHash, randomBytes } from "node:crypto";

import { execute, query, queryOne } from ".";

const TOKEN_PREFIX = "slmcp_";
const MAX_TOKENS_PER_USER = 8;

export interface McpTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface McpTokenRow {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toSummary(row: McpTokenRow): McpTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
  };
}

export class McpTokenLimitError extends Error {
  constructor() {
    super(`最多保留 ${MAX_TOKENS_PER_USER} 个 MCP 令牌,请先撤销不用的`);
    this.name = "McpTokenLimitError";
  }
}

export async function createMcpToken(
  ownerId: string,
  name: string,
): Promise<{ token: string; summary: McpTokenSummary }> {
  const count = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM mcp_tokens WHERE owner_id = $1",
    [ownerId],
  );
  if (Number(count?.n ?? 0) >= MAX_TOKENS_PER_USER) throw new McpTokenLimitError();

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `mcp-${randomBytes(8).toString("hex")}`;
  const row = await queryOne<McpTokenRow>(
    `INSERT INTO mcp_tokens (id, token_hash, owner_id, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, created_at, last_used_at`,
    [id, hashMcpToken(token), ownerId, name.trim().slice(0, 40) || "默认令牌"],
  );
  return { token, summary: toSummary(row!) };
}

export async function listMcpTokens(ownerId: string): Promise<McpTokenSummary[]> {
  const rows = await query<McpTokenRow>(
    `SELECT id, name, created_at, last_used_at
     FROM mcp_tokens WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows.map(toSummary);
}

export async function revokeMcpToken(ownerId: string, id: string): Promise<boolean> {
  const changed = await execute("DELETE FROM mcp_tokens WHERE id = $1 AND owner_id = $2", [
    id,
    ownerId,
  ]);
  return changed === 1;
}

/** 解析请求头里的原始令牌;返回 owner 后,整条 MCP 链路只读这个账号。 */
export async function resolveMcpToken(
  raw: string,
): Promise<{ id: string; ownerId: string } | null> {
  const token = raw.trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await queryOne<{ id: string; owner_id: string; last_used_at: Date | null }>(
    "SELECT id, owner_id, last_used_at FROM mcp_tokens WHERE token_hash = $1",
    [hashMcpToken(token)],
  );
  if (!row) return null;

  // 每次 MCP 调用都写一次时间戳没必要;一分钟内只记第一次
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
    await execute("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(
      () => undefined,
    );
  }
  return { id: row.id, ownerId: row.owner_id };
}
