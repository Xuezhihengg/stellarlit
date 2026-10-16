import { NextResponse } from "next/server";

import type { ApiError, ListStarfieldsResponse } from "@/types/api";

import { listStarfields } from "@/server/starfield/store";

export const dynamic = "force-dynamic";

/** 历史星空列表。按更新时间倒序 —— 用户最近关心的排在最前。 */
export async function GET(): Promise<NextResponse<ListStarfieldsResponse | ApiError>> {
  try {
    return NextResponse.json({ items: await listStarfields() });
  } catch (e) {
    return NextResponse.json(
      { error: "读取历史星空失败", hint: e instanceof Error ? e.message : undefined },
      { status: 500 },
    );
  }
}
