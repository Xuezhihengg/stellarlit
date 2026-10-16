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
import type { RelationPreset } from "@/types/kg";

/** 带可行动提示的错误。界面直接展示 message 与 hint。 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly status?: number,
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
    throw new ApiRequestError(err.error ?? `请求失败(${res.status})`, err.hint, res.status);
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

export function getStarfield(id: string) {
  return request<StarfieldPayload>(`/api/starfield/${encodeURIComponent(id)}`);
}

export function listStarfields() {
  return request<ListStarfieldsResponse>("/api/starfield");
}

export function deleteStarfield(id: string) {
  return request<{ ok: true }>(`/api/starfield/${encodeURIComponent(id)}`, { method: "DELETE" });
}
