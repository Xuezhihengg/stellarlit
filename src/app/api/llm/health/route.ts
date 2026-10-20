import { NextResponse } from "next/server";
import { z } from "zod";

import { chatJson } from "@/server/llm/client";
import { resolveModelById, resolveServiceModel } from "@/server/model-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Probe = z.object({
  ok: z.boolean(),
  answer: z.string().optional(),
});

const bodySchema = z.object({
  modelId: z.string().min(1).optional(),
  provider: z.enum(["openai", "anthropic", "deepseek", "qwen", "custom"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(160).optional(),
});

/** 带 modelId 时测试具体模型;不带时兼容旧客户端,测试关系判定服务。 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "模型参数不正确" });
  }

  const inline =
    parsed.data.provider &&
    parsed.data.baseUrl &&
    parsed.data.apiKey &&
    parsed.data.model
      ? {
          accountId: "inline-test",
          provider: parsed.data.provider,
          baseUrl: parsed.data.baseUrl.replace(/\/+$/, ""),
          apiKey: parsed.data.apiKey,
          model: parsed.data.model,
          name: parsed.data.model,
          modalities: ["text" as const],
        }
      : null;
  const target = inline
    ? inline
    : parsed.data.modelId
      ? await resolveModelById(parsed.data.modelId)
      : await resolveServiceModel("relation");
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
      modelId: parsed.data.modelId,
      target: inline ?? undefined,
      system: "你是一个连通性探针。只输出 JSON,不要任何解释。",
      user: '请回答:下面这句话里有几个字是「力」字?「力拔山兮气盖世」。只输出 {"ok": true, "answer": "数量"}',
      temperature: 0,
      maxTokens: 60,
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
