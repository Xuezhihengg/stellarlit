import { NextResponse } from "next/server";
import { z } from "zod";

import { createSession, isSecureRequest, pruneExpiredSessions, sessionCookie } from "@/server/auth/session";
import { loginUser } from "@/server/auth/users";
import { checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request): Promise<Response> {
  const limit = checkLimit(req, "auth");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code },
      { status: 429, headers: limit.retryAfterSec ? { "retry-after": String(limit.retryAfterSec) } : undefined },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "邮箱或密码格式不正确" }, { status: 400 });
  }

  await pruneExpiredSessions();
  const user = await loginUser(parsed.data.email, parsed.data.password);
  if (!user) {
    // 不区分「邮箱不存在」与「密码错误」,避免账号枚举
    return NextResponse.json({ error: "邮箱或密码不正确", code: "invalid_credentials" }, { status: 401 });
  }

  const session = await createSession(user.id, req.headers.get("user-agent"));
  const response = NextResponse.json({ user });
  response.cookies.set(sessionCookie(session.token, session.expiresAt, isSecureRequest(req)));
  return response;
}
