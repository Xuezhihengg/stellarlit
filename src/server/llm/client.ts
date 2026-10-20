/**
 * 大模型客户端 —— 支持 OpenAI 兼容接口与 Anthropic Messages API。
 *
 * 模型、供应商和密钥统一从 model-settings 解析。所有输出都当作不可信输入:
 * JSON 必须过 schema,图片只接受 API 路由预校验过的 MIME 与 base64。
 */

import type { ZodType } from "zod";

import type { ModelServiceId } from "@/types/model-settings";

import { resolveModelById, resolveServiceModel, type ResolvedModelTarget } from "../model-settings";

export interface ChatImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** 不含 data URL 前缀的 base64 */
  data: string;
}

interface ModelCallOptions {
  service?: ModelServiceId;
  modelId?: string;
  target?: ResolvedModelTarget;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  image?: ChatImage;
}

export interface ChatOptions extends ModelCallOptions {
  retries?: number;
}

export interface StreamChatOptions extends ModelCallOptions {
  signal?: AbortSignal;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  content?: Array<{ type?: string; text?: string }>;
}

async function targetOf(opts: {
  service?: ModelServiceId;
  modelId?: string;
  target?: ResolvedModelTarget;
}): Promise<ResolvedModelTarget | null> {
  if (opts.target) return opts.target;
  if (opts.modelId) return resolveModelById(opts.modelId);
  return resolveServiceModel(opts.service ?? "relation");
}

/** 从模型回复里抠出 JSON。模型常常会裹一层 ```json 围栏或者加一句开场白。 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const direct = tryParse(candidate);
  if (direct !== undefined) return direct;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return undefined;
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function llmAvailable(service: ModelServiceId = "relation"): Promise<boolean> {
  return Boolean(await resolveServiceModel(service));
}

function openAiContent(opts: ModelCallOptions): string | Array<Record<string, unknown>> {
  if (!opts.image) return opts.user;
  return [
    { type: "text", text: opts.user },
    {
      type: "image_url",
      image_url: { url: `data:${opts.image.mimeType};base64,${opts.image.data}` },
    },
  ];
}

function anthropicContent(opts: ModelCallOptions): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: opts.user }];
  if (opts.image) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: opts.image.mimeType,
        data: opts.image.data,
      },
    });
  }
  return content;
}

function requestFor(
  target: ResolvedModelTarget,
  opts: ModelCallOptions,
  stream: boolean,
  jsonMode: boolean,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 1200;

  if (target.provider === "anthropic") {
    return {
      url: `${target.baseUrl.replace(/\/+$/, "")}/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: target.model,
        system: opts.system,
        max_tokens: maxTokens,
        temperature,
        stream,
        messages: [{ role: "user", content: anthropicContent(opts) }],
      },
    };
  }

  return {
    url: `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: {
      model: target.model,
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(stream ? { stream: true } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: openAiContent(opts) },
      ],
    },
  };
}

function nonStreamText(target: ResolvedModelTarget, data: ChatResponse): string {
  if (target.provider === "anthropic") {
    return (data.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return data.choices?.[0]?.message?.content ?? "";
}

function deltaText(
  target: ResolvedModelTarget,
  event: Record<string, unknown>,
): string {
  if (target.provider === "anthropic") {
    if (event.type !== "content_block_delta") return "";
    const delta = event.delta as { text?: string } | undefined;
    return delta?.text ?? "";
  }
  const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content ?? "";
}

/**
 * 调用模型并返回经 schema 校验的结构化结果。
 * 不可用、超时、输出不合法 —— 一律返回 null。
 */
export async function chatJson<T>(
  opts: ChatOptions,
  schema: ZodType<T>,
): Promise<{ value: T; raw: string } | null> {
  const target = await targetOf(opts);
  if (!target) return null;

  const { retries = 1 } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let content = "";
    try {
      const request = requestFor(target, opts, false, true);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      const res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      content = nonStreamText(target, (await res.json()) as ChatResponse);
    } catch {
      if (attempt >= retries) return null;
      continue;
    }

    const parsed = extractJson(content);
    const checked = schema.safeParse(parsed);
    if (checked.success) return { value: checked.data, raw: content };
  }
  return null;
}

/**
 * 流式文本生成 —— 给检索问答用。
 * OpenAI 兼容接口与 Anthropic 的 SSE 事件形状不同,在这里收敛成同一种 delta。
 */
export async function streamChat(
  opts: StreamChatOptions,
  onDelta: (text: string) => void,
): Promise<{ text: string; ok: boolean; error?: string }> {
  const target = await targetOf(opts);
  if (!target) return { text: "", ok: false, error: "未配置问答模型" };
  if (opts.image && !target.modalities.includes("vision")) {
    return {
      text: "",
      ok: false,
      error: "当前问答模型不支持图像,请在设置中绑定多模态模型",
    };
  }

  const request = requestFor(target, opts, true, false);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ac.abort(), 90_000);

  let text = "";
  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error("LLM HTTP error");

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
          const delta = deltaText(
            target,
            JSON.parse(payload) as Record<string, unknown>,
          );
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
    return {
      text,
      ok: false,
      error: opts.signal?.aborted ? undefined : "模型请求失败",
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 非流式文本生成 —— 翻译这类一次性返回的任务用。 */
export async function chatText(opts: {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  service?: ModelServiceId;
  modelId?: string;
}): Promise<string | null> {
  const target = await targetOf(opts);
  if (!target) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const request = requestFor(target, opts, false, false);
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return nonStreamText(target, (await res.json()) as ChatResponse).trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
