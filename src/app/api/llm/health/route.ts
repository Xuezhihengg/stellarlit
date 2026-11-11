import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";
import { z } from "zod";

import { chatJson } from "@/server/llm/client";
import {
  resolveAccountCredentials,
  resolveModelById,
  resolveServiceModel,
} from "@/server/model-settings";
import { checkLimit } from "@/server/safety/limits";
import { MODEL_PROVIDER_IDS } from "@/types/model-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Probe = z.object({
  ok: z.boolean(),
  answer: z.string().optional(),
});

const bodySchema = z.object({
  modelId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  provider: z.enum(MODEL_PROVIDER_IDS).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(160).optional(),
});

/** 带 modelId 时测试具体模型;不带时兼容旧客户端,测试关系判定服务。 */
export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const limit = checkLimit(req, "health");
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: limit.message, hint: limit.hint },
      {
        status: 429,
        headers: limit.retryAfterSec
          ? { "retry-after": String(limit.retryAfterSec) }
          : undefined,
      },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "模型参数不正确" });
  }

  const saved = parsed.data.accountId
    ? await resolveAccountCredentials(auth.user.id, parsed.data.accountId)
    : null;
  const inlineProvider = parsed.data.provider ?? saved?.provider;
  const inlineBaseUrl = parsed.data.baseUrl ?? saved?.baseUrl;
  const inlineApiKey = parsed.data.apiKey ?? saved?.apiKey;
  const inline =
    inlineProvider && inlineBaseUrl && inlineApiKey && parsed.data.model
      ? {
          accountId: "inline-test",
          provider: inlineProvider,
          baseUrl: inlineBaseUrl.replace(/\/+$/, ""),
          apiKey: inlineApiKey,
          model: parsed.data.model,
          name: parsed.data.model,
          modalities: ["text" as const],
        }
      : null;
  const target = inline
    ? inline
    : parsed.data.modelId
      ? await resolveModelById(auth.user.id, parsed.data.modelId)
      : await resolveServiceModel(auth.user.id, "relation");
  if (!target) {
    return NextResponse.json(
      {
        ok: false,
        error: "未配置可用模型",
        hint: "在设置页添加厂商账户和模型,并为服务选择模型",
      },
      { status: 200 },
    );
  }

  const started = Date.now();
  const result = await chatJson(
    {
      ownerId: auth.user.id,
      modelId: parsed.data.modelId,
      target: inline ?? undefined,
      system: "你是一个连通性探针。只输出 JSON,不要任何解释。",
      user: '请回答:下面这句话里有几个字是「力」字?「力拔山兮气盖世」。只输出 {"ok": true, "answer": "数量"}',
      temperature: 0,
      // 探针只输出一个短 JSON,但推理模型的 reasoning 也占这份预算 —— 60 会被推理吃光,
      // 结果明明是通的却被判成"没有返回可解析的结果"。
      maxTokens: 800,
      retries: 0,
    },
    Probe,
  );
  const latencyMs = Date.now() - started;

  if (!result) {
    return NextResponse.json(
      {
        ok: false,
        error: "模型没有返回可解析的结果",
        hint: "常见原因:密钥无效、余额不足、服务地址或模型 ID 不匹配。",
        latencyMs,
        model: target.model,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    model: target.model,
    latencyMs,
    answer: result.value.answer ?? "",
  });
}
