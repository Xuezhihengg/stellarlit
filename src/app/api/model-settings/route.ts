import { NextResponse } from "next/server";
import { z } from "zod";

import { getModelSettings, saveModelSettings } from "@/server/model-settings";

export const dynamic = "force-dynamic";

const schema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        provider: z.enum(["openai", "anthropic", "deepseek", "qwen", "custom"]),
        name: z.string().trim().min(1).max(80),
        baseUrl: z
          .string()
          .url()
          .refine((value) => /^https?:\/\//i.test(value), "只支持 HTTP(S) 地址"),
        hasApiKey: z.boolean(),
        apiKeyHint: z.string().optional(),
        apiKey: z.string().max(500).optional(),
      }),
    )
    .max(12),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        accountId: z.string().min(1).max(80),
        name: z.string().trim().min(1).max(100),
        model: z.string().trim().min(1).max(160),
        modalities: z.array(z.enum(["text", "vision"])).min(1),
      }),
    )
    .max(48),
  services: z.object({
    relation: z.string().nullable(),
    ask: z.string().nullable(),
    translate: z.string().nullable(),
  }),
});

export async function GET() {
  return NextResponse.json(await getModelSettings());
}

export async function PUT(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "模型设置格式不正确" }, { status: 400 });
  }

  try {
    return NextResponse.json(await saveModelSettings(parsed.data));
  } catch (e) {
    return NextResponse.json(
      {
        error: "模型设置保存失败",
        hint: e instanceof Error ? e.message : undefined,
      },
      { status: 500 },
    );
  }
}
