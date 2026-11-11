/**
 * 注册。
 *
 * 第一个账号会接管升级前的本机数据(见 `server/auth/users.ts`),
 * 返回值里带上接管了多少片星空,界面据此给一句明确反馈。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  EmailTakenError,
  registerUser,
} from "@/server/auth/users";
import { createSession, isSecureRequest, sessionCookie } from "@/server/auth/session";
import { checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email("邮箱格式不正确").max(160),
  password: z.string().min(8, "密码至少 8 位").max(200),
  name: z.string().trim().min(1).max(40).optional(),
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "注册信息不完整" },
      { status: 400 },
    );
  }

  try {
    const { user, claimed } = await registerUser(parsed.data);
    const session = await createSession(user.id, req.headers.get("user-agent"));
    const response = NextResponse.json({ user, claimed });
    response.cookies.set(sessionCookie(session.token, session.expiresAt, isSecureRequest(req)));
    return response;
  } catch (error) {
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ error: error.message, code: "email_taken" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "注册失败,请稍后再试", hint: error instanceof Error ? error.message : undefined },
      { status: 500 },
    );
  }
}
