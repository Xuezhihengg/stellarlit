/**
 * MCP over Streamable HTTP。
 *
 * 无状态模式:每个请求新建 server + transport,请求结束即释放。
 * 这样不需要维护会话表,也能被 Claude Desktop / Cursor / 自写客户端直接用
 * `http://localhost:3000/api/mcp` 连上。
 *
 * 安全边界:
 * - 工具全部只读,不改星空、不写文件、不触发模型调用;
 * - 浏览器跨域请求只放行同源。原生 MCP 客户端不带 Origin,照常工作 ——
 *   这样恶意网页没法借用户浏览器把本机调研数据读走;
 * - 外部客户端必须带个人访问令牌,令牌绑定一个账号;没有 Cookie 也不回退到首个账号。
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";

import { createStarfieldMcpServer } from "@/server/mcp/server";
import { resolveMcpToken } from "@/server/db/mcp-tokens";
import { checkLimit } from "@/server/safety/limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOW_HEADERS =
  "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version";

/** 单次 JSON-RPC 载荷上限:工具参数都是短文本,超过这个量级只会是滥用。 */
const MAX_BODY_BYTES = 256 * 1024;

/** 浏览器带来的 Origin 必须与当前 Host 一致;原生客户端没有 Origin,直接放行。 */
function blockedByOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true;
  }
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    Vary: "Origin",
  };
}

function forbidden(): Response {
  return NextResponse.json(
    { error: "不允许来自其它源的 MCP 调用。", hint: "请从同源页面或原生 MCP 客户端连接。" },
    { status: 403 },
  );
}

async function handle(request: Request, ownerId: string): Promise<Response> {
  const server = createStarfieldMcpServer(ownerId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) merged.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  } finally {
    void server.close().catch(() => undefined);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (blockedByOrigin(request)) return forbidden();

  // 令牌是必需的,不是可选的部署开关。生产环境忘记配置也不会退化成公开入口。
  const authorization = request.headers.get("authorization") ?? "";
  const raw = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : request.headers.get("x-stellarlit-token")?.trim() ?? "";
  if (!raw) {
    return NextResponse.json(
      {
        error: "MCP 需要个人访问令牌。",
        hint: "在设置 → MCP 工具中生成令牌,然后在请求头带上 Authorization: Bearer <token>。",
      },
      { status: 401 },
    );
  }
  const token = await resolveMcpToken(raw);
  if (!token) {
    return NextResponse.json(
      { error: "MCP 访问令牌无效或已被撤销。", hint: "请在设置 → MCP 工具中重新生成。" },
      { status: 401 },
    );
  }

  const limit = checkLimit(request, "mcp");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message, hint: limit.hint, code: limit.code },
      {
        status: 429,
        headers: limit.retryAfterSec
          ? { "retry-after": String(limit.retryAfterSec) }
          : undefined,
      },
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "请求体过大。", hint: `单次 MCP 请求上限 ${MAX_BODY_BYTES / 1024}KB。` },
      { status: 413 },
    );
  }

  return handle(request, token.ownerId);
}

export function OPTIONS(request: Request): Response {
  if (blockedByOrigin(request)) return forbidden();
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/** 无状态模式下没有可挂起的 SSE 流,也没有会话可删。 */
export function GET(): Response {
  return NextResponse.json(
    {
      error: "这是无状态的 Streamable HTTP 端点:请用 POST 发送 JSON-RPC。",
      hint: "GET 仅在有状态 SSE 模式下需要,本实现不提供。",
    },
    { status: 405, headers: { Allow: "POST, OPTIONS" } },
  );
}

export function DELETE(request: Request): Response {
  return NextResponse.json(
    { error: "无状态模式没有会话可删除。" },
    { status: 405, headers: { ...corsHeaders(request), Allow: "POST, OPTIONS" } },
  );
}
