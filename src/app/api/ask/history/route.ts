/**
 * 问答历史的读写。
 *
 * 之前历史只存在浏览器的 localStorage 里 —— 换台机器就没了,这是「玩具」和
 * 「产品」最容易被看出来的差别之一。现在由服务端 Postgres 保存,前端只在本地
 * 留一份缓存用于秒开。
 *
 * 校验只做「防止把任意 JSON 塞进库」这一层:嵌套的证据块已经在生成时校验过,
 * 这里限制数量与体积即可,不重复定义一遍完整 schema。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/server/auth/require";
import {
  deleteAskHistory,
  getAskHistoryEntry,
  listAskHistory,
  saveAskHistoryEntry,
} from "@/server/db/ask-history";
import { HISTORY_JSON_BYTES, readJsonLimited } from "@/server/security/request-body";
import type { AskHistoryEntry } from "@/types/rag";

export const dynamic = "force-dynamic";

const entrySchema = z.object({
  id: z.string().min(1).max(80),
  createdAt: z.number().int().positive(),
  question: z.string().min(1).max(2_000),
  answer: z.string().max(40_000),
  sources: z.array(z.unknown()).max(40),
  citations: z.array(z.number().int()).max(40),
  suggestions: z.array(z.unknown()).max(8),
  fallback: z.boolean(),
  imageCount: z.number().int().min(0).max(4).optional(),
  imageEvidence: z.array(z.unknown()).max(64).optional(),
  // 96KB 二进制转 base64 约 128KB;更大的预览应该在客户端先压缩。
  imagePreviews: z.array(z.string().max(140_000)).max(4).optional(),
  trace: z.array(z.unknown()).max(40).optional(),
  decisions: z.array(z.unknown()).max(10).optional(),
});

const bodySchema = z.object({
  starfieldId: z.string().min(1).max(200),
  entry: entrySchema,
});

export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  const starfieldId = new URL(request.url).searchParams.get("starfieldId")?.trim();
  if (!starfieldId) {
    return NextResponse.json({ error: "缺少 starfieldId" }, { status: 400 });
  }
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (id) {
    const entry = await getAskHistoryEntry(auth.user.id, starfieldId, id);
    if (!entry) return NextResponse.json({ error: "这条历史不存在" }, { status: 404 });
    return NextResponse.json({ entry });
  }
  return NextResponse.json({ entries: await listAskHistory(auth.user.id, starfieldId) });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  const body = await readJsonLimited(request, HISTORY_JSON_BYTES);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: "历史记录格式不正确" }, { status: 400 });
  }
  try {
    await saveAskHistoryEntry(auth.user.id, parsed.data.starfieldId, parsed.data.entry as AskHistoryEntry);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // 超过单条上限或磁盘不可写:告诉调用方,但不影响前端已经显示的回答
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "历史保存失败" },
      { status: 422 },
    );
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireUser(request);
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const starfieldId = url.searchParams.get("starfieldId")?.trim();
  if (!starfieldId) {
    return NextResponse.json({ error: "缺少 starfieldId" }, { status: 400 });
  }
  const id = url.searchParams.get("id")?.trim() || undefined;
  return NextResponse.json({ removed: await deleteAskHistory(auth.user.id, starfieldId, id) });
}
