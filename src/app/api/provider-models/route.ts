import { NextResponse } from "next/server";
import { z } from "zod";

import { inferModelModalities } from "@/lib/models/catalog";
import { resolveAccountCredentials } from "@/server/model-settings";

export const dynamic = "force-dynamic";

const schema = z.object({
  accountId: z.string().optional(),
  provider: z.enum(["openai", "anthropic", "deepseek", "qwen", "custom"]),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
});

interface ProviderModel {
  id: string;
  display_name?: string;
}

/** 拉取厂商真实模型列表;编辑已有账户时复用服务端保存的密钥。 */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "连接参数不正确" }, { status: 400 });
  }

  const saved = parsed.data.accountId
    ? await resolveAccountCredentials(parsed.data.accountId)
    : null;
  const provider = parsed.data.provider || saved?.provider;
  const baseUrl = (parsed.data.baseUrl || saved?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = parsed.data.apiKey?.trim() || saved?.apiKey || "";
  if (!baseUrl || !apiKey) {
    return NextResponse.json({
      ok: false,
      error: "请填写 API Key 后再测试连接",
    });
  }

  const headers: Record<string, string> =
    provider === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { authorization: `Bearer ${apiKey}` };

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        error:
          res.status === 401
            ? "API Key 无效或没有模型列表权限"
            : `服务商返回 HTTP ${res.status}`,
      });
    }
    const body = (await res.json()) as { data?: ProviderModel[] };
    const models = (body.data ?? [])
      .map((item) => item.id)
      .filter((id) => id && !/(embedding|rerank|tts|asr|whisper|dall-e|image-generation)/i.test(id))
      .map((id) => ({
        id,
        name: body.data?.find((item) => item.id === id)?.display_name ?? id,
        modalities: inferModelModalities(provider, id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return NextResponse.json({ ok: true, models });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "无法连接服务商,请检查 API Base URL 与网络",
    });
  }
}
