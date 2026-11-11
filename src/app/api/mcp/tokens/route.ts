import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/server/auth/require";
import {
  createMcpToken,
  listMcpTokens,
  McpTokenLimitError,
  revokeMcpToken,
} from "@/server/db/mcp-tokens";
import { checkLimit } from "@/server/safety/limits";
import { readJsonLimited, SMALL_JSON_BYTES } from "@/server/security/request-body";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ tokens: await listMcpTokens(auth.user.id) });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const limit = checkLimit(req, "health");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message, hint: limit.hint, code: limit.code },
      {
        status: 429,
        headers: limit.retryAfterSec
          ? { "retry-after": String(limit.retryAfterSec) }
          : undefined,
      },
    );
  }

  const body = await readJsonLimited(req, SMALL_JSON_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: body.error, code: body.code }, { status: body.status });
  }
  const parsed = createSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: "令牌名称不正确" }, { status: 400 });
  }

  try {
    const created = await createMcpToken(auth.user.id, parsed.data.name ?? "默认令牌");
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof McpTokenLimitError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "缺少令牌 id" }, { status: 400 });
  const revoked = await revokeMcpToken(auth.user.id, id);
  if (!revoked) return NextResponse.json({ error: "令牌不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
