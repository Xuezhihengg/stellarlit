import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/server/auth/require";
import { getSourceSettings, saveSemanticScholarKey } from "@/server/source-settings";
import { checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const Body = z.object({
  semanticScholarKey: z.string().trim().max(200),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await getSourceSettings(auth.user.id));
}

/** 空字符串表示清除;保存后只返回末四位提示。 */
export async function PUT(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const limit = checkLimit(req, "health");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "API Key 格式不正确" }, { status: 400 });
  }

  return NextResponse.json(
    await saveSemanticScholarKey(auth.user.id, parsed.data.semanticScholarKey),
  );
}
