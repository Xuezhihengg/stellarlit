/**
 * Agent 执行层:把已清洗的计划落到 MCP 工具上。
 *
 * 工具不是重新写一遍,而是通过 MCP 协议调用 `src/server/mcp/tools.ts` 的同一份实现。
 * 好处是「站内 Agent 能用的能力」和「外部客户端能用的能力」永远一致:
 * 给 Cursor 接入的 find_relation_evidence,和这里用的是同一段代码。
 *
 * 边界:
 *   - 每次工具调用 12 秒超时;
 *   - 工具结果只作为证据,不能直接当答案;
 *   - 任何一步失败都只是少一块证据,不会让整个问答失败。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { StarfieldPayload } from "@/types/api";
import type { AskStep } from "@/types/rag";

import { createStarfieldMcpServer } from "../mcp/server";
import type { RagSource } from "../rag/corpus";
import { evidenceFromTool, mergeExternal } from "./evidence";
import { AGENT_TOOL_LABELS, type AgentToolName, type PlannedStep } from "./plan";

type ActivitySink = (step: AskStep) => void;

interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function withMcpClient<T>(
  ownerId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createStarfieldMcpServer(ownerId);
  const client = new Client({ name: "stellarlit-agent", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/** 站内 Agent 已经知道自己在这片星空里;这三个工具需要显式传入。 */
const STARFIELD_SCOPED: ReadonlySet<AgentToolName> = new Set([
  "search_starfield",
  "find_relation_evidence",
  "get_paper_context",
]);

async function callTool(
  client: Client,
  step: PlannedStep,
  starfieldId: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const args = STARFIELD_SCOPED.has(step.tool)
    ? { starfieldId, ...step.args }
    : step.args;
  try {
    const result = (await client.callTool(
      { name: step.tool, arguments: args },
      undefined,
      { timeout: 12_000, signal },
    )) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (result.isError) return { ok: false, error: (text ?? "工具返回错误").slice(0, 200) };
    if (!text) return { ok: false, error: "工具没有返回内容" };
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "工具调用失败",
    };
  }
}

/** 用结果里最像「数量」的字段做人话摘要,给轨迹条用。 */
function detailOf(tool: AgentToolName, data: unknown): string {
  const record = (data ?? {}) as Record<string, unknown>;
  if (tool === "search_starfield") {
    const hits = Array.isArray(record.hits) ? record.hits.length : 0;
    return `${hits} 块`;
  }
  if (tool === "find_relation_evidence") {
    if (record.found === false) return "未找到已判定关系";
    const relations = Array.isArray(record.relations) ? record.relations.length : 0;
    return `${relations} 条关系`;
  }
  if (tool === "get_paper_context") {
    const relations = Array.isArray(record.semanticRelations)
      ? record.semanticRelations.length
      : 0;
    return `摘要 + ${relations} 条关系`;
  }
  if (tool === "expand_citations") {
    const works = Array.isArray(record.neighbors) ? record.neighbors.length : 0;
    return `${works} 篇外部结果`;
  }
  const works = Array.isArray(record.results) ? record.results.length : 0;
  return `${works} 篇外部结果`;
}

export interface PlanOutcome {
  sources: RagSource[];
  external: string[];
  trace: AskStep[];
}

export interface ExecuteOptions {
  /** 当前账号:工具读写都限定在这个 owner 下 */
  ownerId: string;
  /** 第几轮执行;轨迹里用来分组 */
  round?: number;
  /** 全局步号起点:跨轮次保持唯一,前端 key 不会撞 */
  startSlot?: number;
  /** 客户端断开时中止外部工具请求。 */
  signal?: AbortSignal;
}

/**
 * 执行一组已清洗过的计划。
 *
 * 单独抽出来,是为了让自检能在**不调用模型**的前提下验证整条工具链路:
 * 规划产物 → MCP 调用 → 证据合并。
 */
export async function executePlan(
  payload: StarfieldPayload,
  plan: PlannedStep[],
  onActivity: ActivitySink,
  options: ExecuteOptions,
): Promise<PlanOutcome> {
  const additions: RagSource[] = [];
  const externalGroups: string[] = [];
  const trace: AskStep[] = [];
  const round = options.round ?? 1;
  const startSlot = options.startSlot ?? 0;

  if (!plan.length) return { sources: [], external: [], trace };

  await withMcpClient(options.ownerId, async (client) => {
    for (const [index, step] of plan.entries()) {
      const slot = startSlot + index;
      const label = AGENT_TOOL_LABELS[step.tool];
      onActivity({
        slot,
        round,
        tool: step.tool,
        label,
        state: "running",
        ...(step.why ? { why: step.why } : {}),
      });

      const outcome = await callTool(client, step, payload.starfield.id, options.signal);
      if (!outcome.ok) {
        const finished: AskStep = {
          slot,
          round,
          tool: step.tool,
          label,
          state: "failed",
          detail: outcome.error,
          ...(step.why ? { why: step.why } : {}),
        };
        trace.push(finished);
        onActivity(finished);
        continue;
      }

      const evidence = evidenceFromTool(payload, step.tool, outcome.data);
      additions.push(...evidence.sources);
      externalGroups.push(...evidence.external);
      const count = evidence.sources.length + evidence.external.length;
      const finished: AskStep = {
        slot,
        round,
        tool: step.tool,
        label,
        state: count > 0 ? "done" : "empty",
        detail: detailOf(step.tool, outcome.data),
        ...(step.why ? { why: step.why } : {}),
      };
      trace.push(finished);
      onActivity(finished);
    }
  });

  return { sources: additions, external: mergeExternal(externalGroups), trace };
}
