import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";
import { z } from "zod";

import { chatText } from "@/server/llm/client";
import { checkBudget, checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  text: z.string().trim().min(1).max(6000),
});

/** 目标语言:中文摘要译成英文,其余译成简体中文。 */
function targetOf(text: string): "zh" | "en" {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk / Math.max(1, text.length) > 0.2 ? "en" : "zh";
}

/**
 * 摘要翻译。
 *
 * 只翻译、不解释、不总结:摘要是证据,用户点"翻译"要的是读得懂的原文,
 * 不是模型对论文的再加工。术语与缩写(mAP、YOLO、R-CNN)保留原文。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const budget = await checkBudget(auth.user.id);
  if (!budget.ok) {
    return NextResponse.json(
      { error: budget.message, hint: budget.hint, code: budget.code, usage: budget.snapshot },
      { status: 429 },
    );
  }

  const limit = checkLimit(req, "translate");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message ?? "请求过于频繁" },
      {
        status: 429,
        headers: limit.retryAfterSec
          ? { "retry-after": String(limit.retryAfterSec) }
          : undefined,
      },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "摘要内容为空或过长" }, { status: 400 });
  }

  const source = parsed.data.text;
  const target = targetOf(source);
  const system =
    target === "zh"
      ? "你是学术翻译。把用户给的论文摘要翻译成简体中文:保留术语、方法名与缩写(YOLO、mAP、R-CNN 等)不译;不要总结、不要补充原文没有的内容;只输出译文。"
      : "You are an academic translator. Translate the user's paper abstract into English. Keep method names and abbreviations as-is; do not summarize or add anything; output only the translation.";

  const text = await chatText({
    ownerId: auth.user.id,
    service: "translate",
    system,
    user: source,
    temperature: 0.2,
    maxTokens: 1800,
  });
  if (!text) {
    return NextResponse.json(
      { error: "翻译服务暂不可用,请确认模型密钥与网络" },
      { status: 503 },
    );
  }
  return NextResponse.json({ text });
}
