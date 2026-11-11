import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/server/auth/require";
import { destroyOtherSessions } from "@/server/auth/session";
import { updateUserPassword, verifyUserPassword } from "@/server/auth/users";
import { checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码").max(200),
  newPassword: z.string().min(8, "新密码至少 8 位").max(200),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

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
      { error: parsed.error.issues[0]?.message ?? "密码格式不正确" },
      { status: 400 },
    );
  }

  const ok = await verifyUserPassword(auth.user.id, parsed.data.currentPassword);
  if (!ok) {
    return NextResponse.json({ error: "当前密码不正确" }, { status: 400 });
  }

  await updateUserPassword(auth.user.id, parsed.data.newPassword);
  // 改密后把其它设备踢掉,当前设备保留 —— 用户不必立刻重新登录
  await destroyOtherSessions(auth.user.id, auth.token);
  return NextResponse.json({ ok: true });
}
