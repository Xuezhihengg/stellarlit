import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/server/auth/require";
import { updateUserName } from "@/server/auth/users";
import { accountStats } from "@/server/db/account";
import { listUsage } from "@/server/db/usage";
import { countSessions } from "@/server/auth/session";
import { usageSnapshot } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1, "昵称不能为空").max(40, "昵称最多 40 个字符"),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const [stats, usage, history, sessions] = await Promise.all([
    accountStats(auth.user.id),
    usageSnapshot(auth.user.id),
    listUsage(auth.user.id, 112),
    countSessions(auth.user.id),
  ]);

  return NextResponse.json({ user: auth.user, stats, usage, history, sessions });
}

export async function PATCH(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "资料格式不正确" },
      { status: 400 },
    );
  }
  const user = await updateUserName(auth.user.id, parsed.data.name);
  if (!user) {
    return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  }
  return NextResponse.json({ user });
}
