import { NextResponse } from "next/server";
import { z } from "zod";

import { MAX_RELATION_PRESETS } from "@/lib/presets/custom";
import { requireUser } from "@/server/auth/require";
import { BUILTIN_PRESETS } from "@/server/relations/presets";
import { RelationPresetSchema } from "@/server/relations/schema";
import {
  clearPresetOverrides,
  readPresetOverrides,
  writePresetOverrides,
} from "@/server/db/presets";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  presets: z.array(RelationPresetSchema).min(1).max(MAX_RELATION_PRESETS),
});

/**
 * 内置预设是「恢复默认」的基准;overrides 是用户自己的覆盖。
 * 两者分开返回,设置页合并后展示,避免用户改过的口径被误当成内置。
 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    presets: BUILTIN_PRESETS,
    overrides: await readPresetOverrides(auth.user.id),
  });
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "预设格式不正确" }, { status: 400 });
  }
  await writePresetOverrides(auth.user.id, parsed.data.presets);
  return NextResponse.json({ overrides: await readPresetOverrides(auth.user.id) });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  await clearPresetOverrides(auth.user.id);
  return NextResponse.json({ ok: true });
}
