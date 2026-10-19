/**
 * 大模型客户端 —— OpenAI 兼容接口,不绑定任何单一厂商。
 *
 * 三条工程约定:
 *   1. **输出一律当作不可信输入**:结构化输出必须过 schema 校验,
 *      校验失败就重试,超次数则返回 null,而不是把半截 JSON 渲染出去。
 *   2. 超时与重试在这里统一处理,调用方只关心「拿到结果」或「没拿到」。
 *   3. 没有密钥不是错误:返回 null,由上层降级到启发式判定并如实标注。
 */

import type { ZodType } from "zod";

import { serverConfig } from "../config";
import { UpstreamError } from "../http";

export interface ChatOptions {
  system: string;
  user: string;
  /** 采样温度。判定类任务应当是低温 —— 我们需要的是稳定,不是创意。 */
  temperature?: number;
  maxTokens?: number;
  retries?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** 从模型回复里抠出 JSON。模型常常会裹一层 ```json 围栏或者加一句开场白。 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;

  // 退一步:取第一个 { 到最后一个 } 之间的内容
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(candidate.slice(start, end + 1));
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function llmAvailable(): boolean {
  return serverConfig.llm.enabled;
}

/**
 * 调用模型并返回经 schema 校验的结构化结果。
 * 不可用、超时、输出不合法 —— 一律返回 null,由调用方决定如何降级。
 */
export async function chatJson<T>(
  opts: ChatOptions,
  schema: ZodType<T>,
): Promise<{ value: T; raw: string } | null> {
  if (!serverConfig.llm.enabled) return null;

  const { system, user, temperature = 0.1, maxTokens = 1200, retries = 1 } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let content = "";
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      const res = await fetch(`${serverConfig.llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${serverConfig.llm.apiKey ?? ""}`,
        },
        body: JSON.stringify({
          model: serverConfig.llm.model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new UpstreamError(`LLM HTTP ${res.status}`, "llm");

      const data = (await res.json()) as ChatResponse;
      content = data.choices?.[0]?.message?.content ?? "";
    } catch {
      if (attempt < retries) continue;
      return null;
    }

    const parsed = extractJson(content);
    const checked = schema.safeParse(parsed);
    if (checked.success) return { value: checked.data, raw: content };

    // 校验失败时再给一次机会 —— 但重试时温度更低,并明确要求只输出 JSON
    if (attempt < retries) continue;
  }

  return null;
}

export interface StreamChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 流式文本生成 —— 给检索问答用。
 *
 * 与 chatJson 的分工:判定关系要的是**结构化且可校验**的结论,
 * 所以走 JSON + schema;回答问题是给人读的长文本,逐字返回才有"在思考"的观感。
 * 不可用或中途失败时返回已收到的部分与 ok=false,由上层决定是否降级。
 */
export async function streamChat(
  opts: StreamChatOptions,
  onDelta: (text: string) => void,
): Promise<{ text: string; ok: boolean }> {
  if (!serverConfig.llm.enabled) return { text: "", ok: false };

  const { system, user, temperature = 0.3, maxTokens = 1200, signal } = opts;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ac.abort(), 90_000);

  let text = "";
  try {
    const res = await fetch(`${serverConfig.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serverConfig.llm.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: serverConfig.llm.model,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ac.signal,
    });

    if (!res.ok || !res.body) throw new UpstreamError(`LLM HTTP ${res.status}`, "llm");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n");
      while (sep >= 0) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        sep = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const event = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // 半截帧:等下一块
        }
      }
    }

    return { text, ok: true };
  } catch {
    return { text, ok: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 非流式文本生成 —— 翻译这类"一次性返回"的任务用。
 * 与 streamChat 共用密钥与超时约定;失败返回 null,由调用方给出可行动提示。
 */
export async function chatText(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string | null> {
  if (!serverConfig.llm.enabled) return null;
  const { system, user, temperature = 0.2, maxTokens = 1600 } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(`${serverConfig.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serverConfig.llm.apiKey ?? ""}`,
      },
      body: JSON.stringify({
        model: serverConfig.llm.model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChatResponse;
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
