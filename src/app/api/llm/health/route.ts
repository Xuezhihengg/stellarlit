import { NextResponse } from "next/server";

import { serverConfig } from "@/server/config";
import { chatJson } from "@/server/llm/client";
import { z } from "zod";

/**
 * 模型连通性自检。
 *
 * 为什么需要一个真的发一次请求的接口:设置页上写着「已连接」,
 * 用户凭什么信?这里让模型回答一个**它必须真的推理才能答对**的小问题,
 * 并把耗时与原始回答一起返回。密钥填错、余额不足、base url 写错 ——
 * 三种失败在这一个接口里都能暴露出来,而不是等到建图时才发现。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Probe = z.object({
  ok: z.boolean(),
  answer: z.string().optional(),
});

export async function POST() {
  if (!serverConfig.llm.enabled) {
    return NextResponse.json(
      {
        ok: false,
        error: "未配置 LLM_API_KEY",
        hint: "在项目根目录的 .env.local 里填写密钥后重启服务",
      },
      { status: 200 },
    );
  }

  const started = Date.now();
  const result = await chatJson(
    {
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
        hint: "常见原因:密钥无效、余额不足、base url 不匹配。请检查 .env.local 的三个 LLM_ 变量。",
        latencyMs,
        model: serverConfig.llm.model,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    model: serverConfig.llm.model,
    latencyMs,
    answer: result.value.answer ?? "",
  });
}
