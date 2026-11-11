/**
 * 大模型客户端 —— 支持 OpenAI 兼容接口与 Anthropic Messages API。
 *
 * 模型、供应商和密钥统一从 model-settings 解析。所有输出都当作不可信输入:
 * JSON 必须过 schema,图片只接受 API 路由预校验过的 MIME 与 base64。
 */

import type { ZodType } from "zod";

import type { ModelServiceId } from "@/types/model-settings";

import { recordUsage } from "../db/usage";
import { resolveModelById, resolveServiceModel, type ResolvedModelTarget } from "../model-settings";

export interface ChatImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** 不含 data URL 前缀的 base64 */
  data: string;
}

interface ModelCallOptions {
  /** 当前登录账号;模型账户与绑定都按它隔离。 */
  ownerId: string;
  service?: ModelServiceId;
  modelId?: string;
  target?: ResolvedModelTarget;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 可多张;顺序与界面上的缩略图一致 */
  images?: ChatImage[];
  /** 非流式调用的超时;规划这类"失败也要快速回退"的调用用它。 */
  timeoutMs?: number;
  /** 客户端断开时中止上游请求,避免继续烧 token。 */
  signal?: AbortSignal;
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

/** 供应商明确拒绝时的可读原因:直接给用户看,不再包一层「请求失败」。 */
class ProviderError extends Error {}

let usageWriteWarned = false;

/** 与 safety/guard 的口径一致:中文约 2 字符 1 token,只用于预算估算。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function estimateInput(opts: { system: string; user: string; images?: ChatImage[] }): number {
  // 图片无法按字符估;每张按 800 token 计,避免带图问答被严重低估
  return estimateTokens(opts.system) + estimateTokens(opts.user) + (opts.images?.length ?? 0) * 800;
}

/** 把调用方 signal 与超时合成一个控制器;dispose 负责清掉计时器与监听。 */
function requestController(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** 用量写入失败不能影响这次模型调用,但要在日志里留一次线索。 */
async function meter(ownerId: string, tokens: number): Promise<void> {
  try {
    await recordUsage(ownerId, tokens);
  } catch (error) {
    if (usageWriteWarned) return;
    usageWriteWarned = true;
    console.error(
      "[usage] token 用量写入失败:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const STATUS_HINT: Record<number, string> = {
  401: "模型密钥无效",
  402: "模型账户余额不足",
  403: "当前密钥无权访问该模型",
  404: "模型不存在或接口地址不对",
  429: "模型限流,请稍后重试",
};

/**
 * 把供应商的 HTTP 错误翻成一句人话。
 *
 * 只取错误消息本身,绝不回显请求头 —— 密钥不能出现在日志或界面里。
 * 余额不足这类问题必须说出来,否则界面只能显示「模型不可用」,
 * 用户会以为是自己网络或配置的问题。
 */
async function describeHttpError(res: Response): Promise<string> {
  const hint = STATUS_HINT[res.status] ?? `模型接口返回 ${res.status}`;
  const raw = await res.text().catch(() => "");
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    detail = parsed.error?.message ?? "";
  } catch {
    detail = raw.slice(0, 120);
  }
  const short = detail.replace(/\s+/g, " ").slice(0, 100).trim();
  return short ? `${hint}(${short})` : hint;
}

async function targetOf(opts: {
  ownerId: string;
  service?: ModelServiceId;
  modelId?: string;
  target?: ResolvedModelTarget;
}): Promise<ResolvedModelTarget | null> {
  if (opts.target) return opts.target;
  if (opts.modelId) return resolveModelById(opts.ownerId, opts.modelId);
  return resolveServiceModel(opts.ownerId, opts.service ?? "relation");
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

export async function llmAvailable(
  ownerId: string,
  service: ModelServiceId = "relation",
): Promise<boolean> {
  return Boolean(await resolveServiceModel(ownerId, service));
}

function openAiContent(opts: ModelCallOptions): string | Array<Record<string, unknown>> {
  const images = opts.images ?? [];
  if (!images.length) return opts.user;
  return [
    { type: "text", text: opts.user },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ];
}

function anthropicContent(opts: ModelCallOptions): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: opts.user }];
  for (const image of opts.images ?? []) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
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
  // 结构化抽取也走同一条多模态入口:文本模型不能假装看过图。
  if ((opts.images?.length ?? 0) > 0 && !target.modalities.includes("vision")) {
    return null;
  }

  const { retries = 1 } = opts;
  const inputTokens = estimateInput(opts);
  let spent = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) break;
    let content = "";
    spent += inputTokens;
    try {
      const request = requestFor(target, opts, false, true);
      const ctrl = requestController(opts.timeoutMs ?? 60_000, opts.signal);
      let res: Response;
      try {
        res = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: ctrl.signal,
        });
      } finally {
        ctrl.dispose();
      }
      if (!res.ok) continue;
      content = nonStreamText(target, (await res.json()) as ChatResponse);
      spent += estimateTokens(content);
    } catch {
      if (attempt >= retries) {
        await meter(opts.ownerId, spent);
        return null;
      }
      continue;
    }

    const parsed = extractJson(content);
    const checked = schema.safeParse(parsed);
    if (checked.success) {
      await meter(opts.ownerId, spent);
      return { value: checked.data, raw: content };
    }
  }
  await meter(opts.ownerId, spent);
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
  if ((opts.images?.length ?? 0) > 0 && !target.modalities.includes("vision")) {
    return {
      text: "",
      ok: false,
      error: "当前问答模型不支持图像,请在设置中绑定多模态模型",
    };
  }

  const request = requestFor(target, opts, true, false);
  const ctrl = requestController(90_000, opts.signal);

  const inputTokens = estimateInput(opts);
  let text = "";
  let truncated = false;
  try {
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ProviderError(await describeHttpError(res));
    if (!res.body) throw new Error("响应没有正文");

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
          const event = JSON.parse(payload) as Record<string, unknown>;
          const choice = (
            event.choices as Array<{ finish_reason?: string | null }> | undefined
          )?.[0];
          if (choice?.finish_reason === "length") truncated = true;

          const delta = deltaText(target, event);
          if (delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // 半截帧:等下一块
        }
      }
    }
    // 推理吃满预算时正文会是空的:这时候要说清是"被截断",而不是让上层
    // 用一个笼统的"不可用"盖过去。
    if (!text.trim() && truncated) {
      return { text, ok: false, error: "推理占满了输出预算,正文被截断" };
    }
    return { text, ok: true };
  } catch (error) {
    return {
      text,
      ok: false,
      error: opts.signal?.aborted
        ? undefined
        : error instanceof ProviderError
          ? error.message
          : `模型请求失败(${error instanceof Error ? error.message : "未知错误"})`,
    };
  } finally {
    ctrl.dispose();
    await meter(opts.ownerId, inputTokens + estimateTokens(text));
  }
}

/** 非流式文本生成 —— 翻译这类一次性返回的任务用。 */
export async function chatText(opts: {
  ownerId: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  service?: ModelServiceId;
  modelId?: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const target = await targetOf(opts);
  if (!target) return null;

  const inputTokens = estimateInput(opts);
  let output = "";
  const ctrl = requestController(60_000, opts.signal);
  try {
    const request = requestFor(target, opts, false, false);
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    output = nonStreamText(target, (await res.json()) as ChatResponse).trim();
    return output || null;
  } catch {
    return null;
  } finally {
    ctrl.dispose();
    await meter(opts.ownerId, inputTokens + estimateTokens(output));
  }
}
