import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";
import { z } from "zod";

import { probeEmbedding } from "@/server/rag/embedding";

export const dynamic = "force-dynamic";

const schema = z.object({
  accountId: z.string().min(1),
  model: z.string().trim().min(1).max(160),
});

/** 设置页专用:只验证指定账户的 /embeddings 能否返回向量。 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "请选择服务商并填写模型 ID" });
  }
  return NextResponse.json(await probeEmbedding(auth.user.id, parsed.data));
}
