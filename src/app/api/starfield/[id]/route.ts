import { NextResponse } from "next/server";

import type { ApiError, StarfieldPayload } from "@/types/api";

import { deleteStarfield, loadStarfield } from "@/server/starfield/store";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse<StarfieldPayload | ApiError>> {
  const { id } = await ctx.params;
  const payload = await loadStarfield(id);
  if (!payload) {
    return NextResponse.json({ error: "这片星空不存在或已被删除", code: "not_found" }, { status: 404 });
  }
  return NextResponse.json(payload);
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse<{ ok: true }>> {
  const { id } = await ctx.params;
  await deleteStarfield(id);
  return NextResponse.json({ ok: true });
}
