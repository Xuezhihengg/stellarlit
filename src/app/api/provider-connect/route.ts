/**
 * 服务商连通性探测。
 *
 * 只回答一件事:这个 Base URL + Key 现在能不能连上。
 * 不返回模型清单 —— 拉清单是另一个动作,失败时不该被当成「连接失败」,
 * 反过来,连接失败时也不该让用户以为是模型 ID 填错了。
 */

import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";
import { z } from "zod";

import { resolveAccountCredentials } from "@/server/model-settings";
import { checkLimit } from "@/server/safety/limits";
import { readJsonLimited, SMALL_JSON_BYTES } from "@/server/security/request-body";
import { MODEL_PROVIDER_IDS } from "@/types/model-settings";

export const dynamic = "force-dynamic";

const schema = z.object({
  accountId: z.string().optional(),
  provider: z.enum(MODEL_PROVIDER_IDS),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
});

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  // 同样的探测动作:防止有人拿它当免费代理刷上游
  const limit = checkLimit(req, "health");
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code },
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
    return NextResponse.json({ ok: false, error: body.error, code: body.code }, { status: body.status });
  }
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "连接参数不正确" }, { status: 400 });
  }

  const saved = parsed.data.accountId
    ? await resolveAccountCredentials(auth.user.id, parsed.data.accountId)
    : null;
  const provider = parsed.data.provider || saved?.provider;
  const baseUrl = (parsed.data.baseUrl || saved?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = parsed.data.apiKey?.trim() || saved?.apiKey || "";
  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "请先填写 API Base URL" });
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "请先填写 API Key" });
  }

  const headers: Record<string, string> =
    provider === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { authorization: `Bearer ${apiKey}` };

  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    const latency = Date.now() - startedAt;

    // 401/403 是密钥问题,404 多半是地址问题;其余状态码说明地址至少可达。
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, error: "API Key 无效或没有访问权限" });
    }
    if (res.status === 404) {
      return NextResponse.json({
        ok: false,
        error: "Base URL 可能不是兼容接口地址(找不到 /models)",
      });
    }
    if (res.status >= 500) {
      return NextResponse.json({
        ok: false,
        error: `服务商暂时不可用(HTTP ${res.status})`,
      });
    }
    if (res.status === 429) {
      return NextResponse.json({ ok: true, latencyMs: latency, message: `连接正常 · ${latency} ms · 当前限流` });
    }
    return NextResponse.json({
      ok: true,
      latencyMs: latency,
      message: `连接正常 · ${latency} ms`,
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "无法连接,请检查 Base URL 与网络",
    });
  }
}
