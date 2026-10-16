import { NextResponse } from "next/server";
import { z } from "zod";

import type { ApiError, GrowResponse } from "@/types/api";

import { growStarfield } from "@/server/starfield/grow";
import { RelationPresetSchema } from "@/server/relations/schema";

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
  presets: z.array(RelationPresetSchema).max(24).optional(),
});

export async function POST(req: Request): Promise<NextResponse<GrowResponse | ApiError>> {
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
    const payload = await growStarfield(parsed.data);
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
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
