import { z } from "zod";
import { requireUser } from "@/server/auth/require";
import { checkBudget, checkLimit } from "@/server/safety/limits";
import { readPresetOverrides } from "@/server/db/presets";

import type { ApiError, GrowRequest } from "@/types/api";

import { UpstreamError } from "@/server/http";
import { growStarfieldStream } from "@/server/starfield/grow";
import { RelationPresetSchema } from "@/server/relations/schema";
import { MAX_RELATION_PRESETS } from "@/lib/presets/custom";
import { resolveSourceContext } from "@/server/source-settings";

/**
 * 流式构建。
 *
 * 为什么要流式:一次冷启动要跑十几秒的模型判定。串行等待的体验是
 * 「点了按钮,然后盯着转圈」——用户既不知道进展,也不知道值不值得等。
 * 改成流式之后,结构骨架在一秒内先出现,关系再一条条亮起来,
 * 等待变成了"看着它长出来"。
 *
 * 用 POST + 手写 SSE 而不是 EventSource:EventSource 只能发 GET,
 * 而构建参数(种子、预设、深度)是一段结构化请求体,塞进 query 不合适。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  starfieldId: z.string().max(120).optional(),
  seedPaperId: z.string().min(3).max(120),
  name: z.string().max(160).optional(),
  budget: z.number().int().min(40).max(600).optional(),
  pool: z.number().int().min(6).max(200).optional(),
  judgeDepth: z.number().int().min(4).max(40).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  presets: z.array(RelationPresetSchema).max(MAX_RELATION_PRESETS).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const budget = await checkBudget(auth.user.id);
  if (!budget.ok) {
    return Response.json(
      { error: budget.message ?? "今日 token 预算已用完", hint: budget.hint, code: budget.code } satisfies ApiError,
      { status: 429 },
    );
  }

  const limit = checkLimit(req, "grow");
  if (!limit.ok) {
    return Response.json(
      { error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code } satisfies ApiError,
      { status: 429, headers: limit.retryAfterSec ? { "retry-after": String(limit.retryAfterSec) } : undefined },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" } satisfies ApiError, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "参数不合法", hint: "需要 seedPaperId,以及可选的 starfieldId" } satisfies ApiError,
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const input: GrowRequest & {
    depth?: number;
    ownerId: string;
    source: Awaited<ReturnType<typeof resolveSourceContext>>;
  } = {
    ...(parsed.data.presets?.length
      ? parsed.data
      : { ...parsed.data, presets: (await readPresetOverrides(auth.user.id)) ?? undefined }),
    ownerId: auth.user.id,
    source: await resolveSourceContext(auth.user.id),
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        for await (const event of growStarfieldStream(input)) {
          send(event);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // 配额用尽要单独说清楚:它不是"等一下再试",而是"十几个小时后才有"
        const quota = e instanceof UpstreamError ? e.quota : undefined;
        send({
          type: "error",
          code: quota ? "quota" : "upstream",
          message: quota
            ? `OpenAlex 的每日请求额度已用完,约 ${Math.max(0.1, quota.resetAfterSec / 3600).toFixed(1)} 小时后重置。已构建过的星空不受影响。`
            : message,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 关掉反向代理的缓冲,否则事件会被攒成一坨再吐出来,流式就没意义了
      "x-accel-buffering": "no",
    },
  });
}
