import { NextResponse } from "next/server";

import { requireUser } from "@/server/auth/require";
import { deleteStarfield, loadStarfield } from "@/server/starfield/store";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const payload = await loadStarfield(id, auth.user.id);
  if (!payload) {
    return NextResponse.json({ error: "这片星空不存在或已被删除", code: "not_found" }, { status: 404 });
  }
  return NextResponse.json(payload);
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  await deleteStarfield(id, auth.user.id);
  return NextResponse.json({ ok: true });
}
