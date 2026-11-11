import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";
import { checkBudget, checkLimit } from "@/server/safety/limits";
import { readPresetOverrides } from "@/server/db/presets";
import { z } from "zod";

import type { ApiError } from "@/types/api";

import { UpstreamError } from "@/server/http";
import { growStarfield } from "@/server/starfield/grow";
import { RelationPresetSchema } from "@/server/relations/schema";
import { MAX_RELATION_PRESETS } from "@/lib/presets/custom";

/**
 * 构建星空是最重的操作:要抓取邻域、跑社区检测与布局,还可能调用大模型判定关系。
 * 因此单独给它更长的超时预算。
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
  presets: z.array(RelationPresetSchema).max(MAX_RELATION_PRESETS).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const budget = await checkBudget(auth.user.id);
  if (!budget.ok) {
    return NextResponse.json(
      { error: budget.message, hint: budget.hint, code: budget.code, usage: budget.snapshot },
      { status: 429 },
    );
  }

  const limit = checkLimit(req, "grow");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code } as ApiError,
      { status: 429, headers: limit.retryAfterSec ? { "retry-after": String(limit.retryAfterSec) } : undefined },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "参数不合法", hint: "需要 seedPaperId,以及可选的 starfieldId" },
      { status: 400 },
    );
  }

  try {
    // 客户端没带预设时,用服务端保存的自定义口径 —— 否则换了台机器就会悄悄退回内置判定
    const input = parsed.data.presets?.length
      ? parsed.data
      : { ...parsed.data, presets: (await readPresetOverrides(auth.user.id)) ?? undefined };
    const payload = await growStarfield({ ...input, ownerId: auth.user.id });
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    /**
     * 配额用尽要单独说清楚。
     *
     * 它和"网络不通"是两回事:后者等一会儿再试就好,前者要等十几个小时
     * 或者换一个数据源配额。混在一句"暂时不可用"里,用户会一直刷新重试,
     * 而每一次重试都在继续消耗已经很紧张的额度。
     */
    const quota = e instanceof UpstreamError ? e.quota : undefined;
    if (quota) {
      const hours = Math.max(0.1, quota.resetAfterSec / 3600);
      return NextResponse.json(
        {
          error: "OpenAlex 的每日请求额度已用完",
          hint: `免费额度是每天 1000 次请求,约 ${hours.toFixed(1)} 小时后重置(约 ${new Date(
            Date.now() + quota.resetAfterSec * 1000,
          ).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 可用)。已构建过的星空不受影响,可以照常打开。`,
          code: "quota",
        },
        { status: 503 },
      );
    }

    // 上游不可用与内部错误要分开:前者用户等待重试有意义,后者没有
    const isUpstream = /请求失败|HTTP \d|upstream/i.test(message);
    return NextResponse.json(
      {
        error: isUpstream ? "文献数据源暂时不可用,请稍后重试" : "构建星图时出错",
        hint: message,
        code: isUpstream ? "upstream" : "internal",
      },
      { status: isUpstream ? 502 : 500 },
    );
  }
}
