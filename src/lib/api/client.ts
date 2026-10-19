/**
 * 前端调用自己后端的唯一入口。
 *
 * 组件里不出现裸 fetch:错误形状、超时、JSON 解析都只在这里处理一次,
 * 否则每个组件都会有一套自己的错误处理,而且各不相同。
 */

import type {
  ApiError,
  CapabilityReport,
  GrowRequest,
  ListStarfieldsResponse,
  ResolveSeedResponse,
  StarfieldPayload,
} from "@/types/api";
import type { Graph, GraphLayout, RelationPreset } from "@/types/kg";
import type { AskEvent, AskRequest, AskSource, AskSuggestion } from "@/types/rag";
import type { Starfield } from "@/types/starfield";

/** 带可行动提示的错误。界面直接展示 message 与 hint。 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly status?: number,
    /** 服务端给的机器可读分类(如 quota),用来决定这条错误该出现在哪 */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiRequestError("无法连接到服务端", "请确认开发服务器正在运行");
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiRequestError("服务端返回了无法解析的内容", undefined, res.status);
  }

  if (!res.ok) {
    const err = data as ApiError;
    throw new ApiRequestError(
      err.error ?? `请求失败(${res.status})`,
      err.hint,
      res.status,
      err.code,
    );
  }
  return data as T;
}

export function fetchCapabilities(): Promise<CapabilityReport> {
  return request<CapabilityReport>("/api/capabilities");
}

/** 内置关系预设 —— 设置页拿它作为「恢复默认」的基准。 */
export async function fetchPresets(): Promise<RelationPreset[]> {
  const res = await request<{ presets: RelationPreset[] }>("/api/presets");
  return res.presets;
}

export interface LlmHealth {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  answer?: string;
  error?: string;
  hint?: string;
}

/**
 * 模型连通性自检。
 *
 * 刻意返回 200 + ok:false,而不是用 HTTP 错误码 ——
 * 「密钥没配」是一种**正常的业务状态**,不是服务端故障,
 * 界面据 ok 字段渲染即可,不必区分 catch 与 success 两条路径。
 */
export function testLlm(): Promise<LlmHealth> {
  return request<LlmHealth>("/api/llm/health", { method: "POST" });
}

export function resolveSeed(query: string, knownPaperIds: string[] = []) {
  return request<ResolveSeedResponse>("/api/seed/resolve", {
    method: "POST",
    body: JSON.stringify({ query, knownPaperIds }),
  });
}

export function growStarfield(req: GrowRequest) {
  return request<StarfieldPayload>("/api/starfield/grow", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ---------------------------------------------------------------------------
// 流式构建
// ---------------------------------------------------------------------------

export interface GrowStreamHandlers {
  /** 结构骨架就绪(通常一秒内) */
  onStructure: (e: { starfield: Starfield; graph: Graph; layout: GraphLayout }) => void;
  /** 又长出了新论文:整张图的最新快照 */
  onGraph: (e: { graph: Graph; layout: GraphLayout }) => void;
  onProgress: (e: {
    round: number;
    depth: number;
    judged: number;
    matched: number;
    llmCalls: number;
    estimatedTokens: number;
  }) => void;
  onDone: (payload: StarfieldPayload) => void;
  onError: (message: string, code?: string) => void;
}

/**
 * 流式构建星空。
 *
 * 用手写 fetch + ReadableStream 而不是 EventSource:EventSource 只能发 GET,
 * 而构建参数是一段结构化请求体。SSE 的分帧规则很简单(空行分隔、`data: ` 前缀),
 * 自己解析比引入一个依赖划算 —— 也能顺手处理"最后一帧没收完就断流"的情况,
 * 那正是移动网络下最常见的一种失败。
 */
export async function growStarfieldStream(
  req: GrowRequest,
  handlers: GrowStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/starfield/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    handlers.onError("无法连接到服务端");
    return;
  }

  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    handlers.onError(err.error ?? `请求失败(${res.status})`, err.code);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");

        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          continue; // 半截帧:丢掉,不打断整个流
        }
        dispatchEvent(event, handlers);
      }
    }
  } catch {
    // 用户主动取消不算错误
    if (!signal?.aborted) handlers.onError("连接中断,已保留当前进度");
  } finally {
    reader.releaseLock();
  }
}

function dispatchEvent(
  event: Record<string, unknown>,
  handlers: GrowStreamHandlers,
): void {
  switch (event.type) {
    case "structure":
      handlers.onStructure(
        event as unknown as { starfield: Starfield; graph: Graph; layout: GraphLayout },
      );
      break;
    case "graph":
      handlers.onGraph(event as unknown as { graph: Graph; layout: GraphLayout });
      break;
    case "progress":
      handlers.onProgress(
        event as unknown as {
          round: number;
          depth: number;
          judged: number;
          matched: number;
          llmCalls: number;
          estimatedTokens: number;
        },
      );
      break;
    case "done":
      handlers.onDone((event as unknown as { payload: StarfieldPayload }).payload);
      break;
    case "error":
      handlers.onError(
        String(event.message ?? "构建失败"),
        typeof event.code === "string" ? event.code : undefined,
      );
      break;
    default:
      break;
  }
}

export function getStarfield(id: string) {
  return request<StarfieldPayload>(`/api/starfield/${encodeURIComponent(id)}`);
}

export function listStarfields() {
  return request<ListStarfieldsResponse>("/api/starfield");
}

export function deleteStarfield(id: string) {
  return request<{ ok: true }>(`/api/starfield/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface AskHandlers {
  onSources: (sources: AskSource[]) => void;
  onDelta: (text: string) => void;
  onDone: (
    citations: number[],
    fallback: boolean,
    suggestions: AskSuggestion[],
  ) => void;
  onError: (message: string) => void;
}

/**
 * 提问 —— 流式回答。
 *
 * 与构建星空的流不同,这里的每一帧都是给人读的:先给依据(sources),
 * 再逐字给答案(delta)。解析逻辑和 grow 的 SSE 一样(空行分隔、`data: ` 前缀),
 * 只是事件类型换成 AskEvent。
 */
export async function askStarfield(
  req: AskRequest,
  handlers: AskHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    if (!signal?.aborted) handlers.onError("无法连接到服务端");
    return;
  }

  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    handlers.onError(err.error ?? `请求失败(${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");

        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;

        let event: AskEvent;
        try {
          event = JSON.parse(line.slice(6)) as AskEvent;
        } catch {
          continue;
        }

        if (event.type === "sources") handlers.onSources(event.sources);
        else if (event.type === "delta") handlers.onDelta(event.text);
        else if (event.type === "done") {
          handlers.onDone(event.citations, Boolean(event.fallback), event.suggestions ?? []);
        } else if (event.type === "error") handlers.onError(event.message);
      }
    }
  } catch {
    if (!signal?.aborted) handlers.onError("回答中断,请重试");
  } finally {
    reader.releaseLock();
  }
}
