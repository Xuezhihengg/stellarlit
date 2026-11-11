/** 路由与页面共用的「当前账号」读取。 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readSession, SESSION_COOKIE, type SessionUser } from "./session";

function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/** 从请求头读会话。route handler 用这个,不依赖 next/headers 的异步 API。 */
export async function userFromRequest(req: Request): Promise<SessionUser | null> {
  const token = tokenFromCookieHeader(req.headers.get("cookie"));
  return token ? readSession(token) : null;
}

export type AuthResult =
  | { ok: true; user: SessionUser; token: string }
  | { ok: false; response: Response };

/** 数据类路由的第一行:没登录就不要继续读写了。 */
export async function requireUser(req: Request): Promise<AuthResult> {
  const token = tokenFromCookieHeader(req.headers.get("cookie"));
  const user = token ? await readSession(token) : null;
  if (!user || !token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "请先登录", hint: "登录后你的星空与问答历史才会归属于这个账号。", code: "unauthorized" },
        { status: 401 },
      ),
    };
  }
  return { ok: true, user, token };
}

/** Server Component 用这个,读不到就返回 null,由页面决定跳转。 */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? readSession(token) : null;
}
