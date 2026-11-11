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
import type {
  AccountOverviewDto,
  AccountUser,
  UsageSnapshotDto,
} from "@/types/account";
import type { Graph, GraphLayout, RelationPreset } from "@/types/kg";
import type { McpTokenCreateResult, McpTokenSummary } from "@/types/mcp";
import type {
  ModelModality,
  ModelProviderId,
  ModelSettingsDto,
  SaveModelSettingsRequest,
} from "@/types/model-settings";
import type {
  AskDecision,
  AskEvent,
  AskHistoryEntry,
  AskHistorySummary,
  AskImageIndexStats,
  AskRequest,
  AskSource,
  AskStep,
  AskSuggestion,
  ImageEvidence,
} from "@/types/rag";
import type { Starfield } from "@/types/starfield";
import { navigateWithFade } from "@/lib/navigation/transition";

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

interface RequestOptions {
  /** 401 时是否跳到登录页。登录/注册接口自己是「预期会 401」的,要关掉。 */
  redirectOnUnauthorized?: boolean;
}

async function request<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
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
    if (res.status === 401 && options?.redirectOnUnauthorized !== false && typeof window !== "undefined") {
      const url = new URL("/login", window.location.origin);
      url.searchParams.set("next", `${window.location.pathname}${window.location.search}`);
      navigateWithFade(url.toString(), { replace: true });
    }
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

/** 服务端保存的自定义预设;没有改过时返回 null。 */
export async function fetchPresetOverrides(): Promise<RelationPreset[] | null> {
  const res = await request<{ overrides: RelationPreset[] | null }>("/api/presets");
  return res.overrides;
}

export async function savePresetOverrides(presets: RelationPreset[]): Promise<void> {
  await request<{ overrides: RelationPreset[] | null }>("/api/presets", {
    method: "PUT",
    body: JSON.stringify({ presets }),
  });
}

export async function clearPresetOverridesRemote(): Promise<void> {
  await request<{ ok: boolean }>("/api/presets", { method: "DELETE" });
}

export interface LlmHealth {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  answer?: string;
  error?: string;
  hint?: string;
}

export interface LlmTestTarget {
  modelId?: string;
  accountId?: string;
  provider?: ModelProviderId;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 模型连通性自检。
 *
 * 刻意返回 200 + ok:false,而不是用 HTTP 错误码 ——
 * 「密钥没配」是一种**正常的业务状态**,不是服务端故障,
 * 界面据 ok 字段渲染即可,不必区分 catch 与 success 两条路径。
 */
export function testLlm(target?: string | LlmTestTarget): Promise<LlmHealth> {
  return request<LlmHealth>("/api/llm/health", {
    method: "POST",
    body: JSON.stringify(typeof target === "string" ? { modelId: target } : target ?? {}),
  });
}

export function getModelSettings(): Promise<ModelSettingsDto> {
  return request<ModelSettingsDto>("/api/model-settings");
}

export function saveModelSettings(
  settings: SaveModelSettingsRequest,
): Promise<ModelSettingsDto> {
  return request<ModelSettingsDto>("/api/model-settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export interface EmbeddingHealth {
  ok: boolean;
  dimensions?: number;
  latencyMs?: number;
  error?: string;
}

/** 测试当前账户与向量模型是否真的能返回 embedding。 */
export function testEmbedding(input: {
  accountId: string;
  model: string;
}): Promise<EmbeddingHealth> {
  return request<EmbeddingHealth>("/api/embedding/health", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ProviderConnectResponse {
  ok: boolean;
  latencyMs?: number;
  message?: string;
  error?: string;
}

/** 只测 Base URL + Key 的连通性,不拉模型清单。 */
export function probeProvider(input: {
  accountId?: string;
  provider: ModelProviderId;
  baseUrl: string;
  apiKey?: string;
}): Promise<ProviderConnectResponse> {
  return request<ProviderConnectResponse>("/api/provider-connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ProviderModelsResponse {
  ok: boolean;
  models?: Array<{
    id: string;
    name: string;
    modalities: ModelModality[];
  }>;
  error?: string;
}

export function fetchProviderModels(input: {
  accountId?: string;
  provider: ModelProviderId;
  baseUrl: string;
  apiKey?: string;
}): Promise<ProviderModelsResponse> {
  return request<ProviderModelsResponse>("/api/provider-models", {
    method: "POST",
    body: JSON.stringify(input),
  });
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
    if (!signal?.aborted) handlers.onError("无法连接到服务端");
    return;
  }

  if (res.status === 401) {
    const url = new URL("/login", window.location.origin);
    url.searchParams.set("next", `${window.location.pathname}${window.location.search}`);
    navigateWithFade(url.toString(), { replace: true });
    handlers.onError("登录已过期,请重新登录");
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

/** 摘要翻译(目标语言由服务端按原文语言判断)。 */
export function translateText(text: string): Promise<{ text: string }> {
  return request<{ text: string }>("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export interface AskHandlers {
  onSources: (sources: AskSource[]) => void;
  /** 附图 OCR / 表格 / 图表块;在 sources 之后、答案之前到达 */
  onImageEvidence?: (
    evidence: ImageEvidence[],
    stats: AskImageIndexStats,
  ) => void;
  /** Agent 执行轨迹:每一步先 running,结束后变成 done/empty/failed */
  onActivity?: (step: AskStep) => void;
  /** 每轮结束后的继续/停止判定 */
  onDecision?: (decision: AskDecision) => void;
  onDelta: (text: string) => void;
  onDone: (
    citations: number[],
    fallback: boolean,
    suggestions: AskSuggestion[],
    fallbackReason?: string,
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

  if (res.status === 401) {
    const url = new URL("/login", window.location.origin);
    url.searchParams.set("next", `${window.location.pathname}${window.location.search}`);
    navigateWithFade(url.toString(), { replace: true });
    handlers.onError("登录已过期,请重新登录");
    return;
  }

  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as ApiError;
    // 限流/护栏的拒绝都带「下一步怎么办」,拼在同一行里,避免界面只显示一句冷冰冰的错误。
    const message = err.error ?? `请求失败(${res.status})`;
    handlers.onError(err.hint ? `${message} · ${err.hint}` : message);
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
        else if (event.type === "imageEvidence") {
          handlers.onImageEvidence?.(event.evidence, event.stats);
        }
        else if (event.type === "activity") handlers.onActivity?.(event.step);
        else if (event.type === "decision") handlers.onDecision?.(event.decision);
        else if (event.type === "delta") handlers.onDelta(event.text);
        else if (event.type === "done") {
          handlers.onDone(
            event.citations,
            Boolean(event.fallback),
            event.suggestions ?? [],
            event.fallbackReason,
          );
        } else if (event.type === "error") handlers.onError(event.message);
      }
    }
  } catch {
    if (!signal?.aborted) handlers.onError("回答中断,请重试");
  } finally {
    reader.releaseLock();
  }
}

/**
 * 问答历史 —— 服务端是主副本,本地缓存只是「秒开」。
 *
 * 失败一律静默:保存历史失败不该让用户刚看到的回答消失。
 */
export async function fetchAskHistory(starfieldId: string): Promise<AskHistorySummary[]> {
  const res = await request<{ entries: AskHistorySummary[] }>(
    `/api/ask/history?starfieldId=${encodeURIComponent(starfieldId)}`,
  );
  return res.entries;
}

/** 列表只带摘要;真正回放某一条时再取完整详情。 */
export async function fetchAskHistoryEntry(
  starfieldId: string,
  id: string,
): Promise<AskHistoryEntry> {
  const query = new URLSearchParams({ starfieldId, id });
  const res = await request<{ entry: AskHistoryEntry }>(
    `/api/ask/history?${query.toString()}`,
  );
  return res.entry;
}

export async function saveAskHistory(
  starfieldId: string,
  entry: AskHistoryEntry,
): Promise<void> {
  await request<{ ok: boolean }>("/api/ask/history", {
    method: "POST",
    body: JSON.stringify({ starfieldId, entry }),
  });
}

export async function clearAskHistory(starfieldId: string, id?: string): Promise<void> {
  const query = new URLSearchParams({ starfieldId });
  if (id) query.set("id", id);
  await request<{ removed: number }>(`/api/ask/history?${query.toString()}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface ClaimedData {
  starfields: number;
  history: number;
  presets: number;
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await request<{ user: AuthUser | null }>("/api/auth/me", undefined, {
    redirectOnUnauthorized: false,
  });
  return res.user;
}

export async function loginAccount(email: string, password: string): Promise<AuthUser> {
  const res = await request<{ user: AuthUser }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    { redirectOnUnauthorized: false },
  );
  return res.user;
}

export async function registerAccount(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: AuthUser; claimed: ClaimedData }> {
  return request<{ user: AuthUser; claimed: ClaimedData }>(
    "/api/auth/register",
    { method: "POST", body: JSON.stringify(input) },
    { redirectOnUnauthorized: false },
  );
}

export async function logoutAccount(): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }, {
    redirectOnUnauthorized: false,
  });
}

export function fetchUsage(): Promise<UsageSnapshotDto> {
  return request<UsageSnapshotDto>("/api/usage");
}

export function fetchAccount(): Promise<AccountOverviewDto> {
  return request<AccountOverviewDto>("/api/account");
}

export async function updateAccountName(name: string): Promise<AccountUser> {
  const res = await request<{ user: AccountUser }>("/api/account", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  return res.user;
}

export async function changeAccountPassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await request<{ ok: boolean }>("/api/account/password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeAllSessions(): Promise<void> {
  await request<{ ok: boolean }>("/api/account/sessions", { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// MCP 个人令牌
// ---------------------------------------------------------------------------

export async function fetchMcpTokens(): Promise<McpTokenSummary[]> {
  const res = await request<{ tokens: McpTokenSummary[] }>("/api/mcp/tokens");
  return res.tokens;
}

export function createMcpToken(name: string): Promise<McpTokenCreateResult> {
  return request<McpTokenCreateResult>("/api/mcp/tokens", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function revokeMcpToken(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
