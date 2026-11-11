/**
 * 会话 —— 随机令牌 + 数据库里的哈希。
 *
 * 浏览器只拿到 32 字节随机串;库里存 SHA-256,即使数据库泄露也没法直接冒用会话。
 * Cookie 是 httpOnly + SameSite=Lax:脚本读不到,跨站请求不会自动带上。
 */

import { createHash, randomBytes } from "node:crypto";

import { execute, queryOne } from "../db";

export const SESSION_COOKIE = "stellarlit_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  userAgent?: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await execute(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), userId, expiresAt, userAgent?.slice(0, 200) ?? null],
  );
  return { token, expiresAt };
}

export async function readSession(token: string): Promise<SessionUser | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const row = await queryOne<{
    id: string;
    email: string;
    name: string;
    created_at: Date;
    expires_at: string;
  }>(
    `SELECT u.id, u.email, u.name, u.created_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash],
  );
  if (!row) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await execute("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at.toISOString(),
  };
}

export async function destroySession(token: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

/** 改密后保留当前设备,把其它设备的会话踢掉。 */
export async function destroyOtherSessions(userId: string, keepToken: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [
    userId,
    hashToken(keepToken),
  ]);
}

export async function countSessions(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM sessions WHERE user_id = $1 AND expires_at > $2",
    [userId, Date.now()],
  );
  return Number(row?.n ?? 0);
}

/** 顺手清掉过期会话;登录时调用一次,不需要定时任务。 */
export async function pruneExpiredSessions(): Promise<number> {
  return execute("DELETE FROM sessions WHERE expires_at <= $1", [Date.now()]);
}

/**
 * secure 不能只看 NODE_ENV:`pnpm start` 在本机 http://localhost 上也会是 production,
 * 一刀切加 Secure 会让本地演示登录不上。按实际请求协议判断更准确。
 */
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(req.url).protocol === "https:";
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  };
}
