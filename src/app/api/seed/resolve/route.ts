import { NextResponse } from "next/server";
import { z } from "zod";

import type { ApiError, ResolveSeedResponse } from "@/types/api";

import { UpstreamError } from "@/server/http";
import { resolveSeed } from "@/server/seed/resolve";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  query: z.string().min(1).max(400),
  knownPaperIds: z.array(z.string()).max(2000).optional(),
});

export async function POST(req: Request): Promise<NextResponse<ResolveSeedResponse | ApiError>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "查询内容为空或过长" }, { status: 400 });
  }

  try {
    const candidates = await resolveSeed(
      parsed.data.query,
      new Set(parsed.data.knownPaperIds ?? []),
    );
    if (!candidates.length) {
      return NextResponse.json(
        {
          error: "没有找到匹配的论文",
          hint: "换个说法试试:可以是论文标题、arXiv ID(如 1706.03762)、DOI 或 OpenAlex ID(如 W2626778328)。",
          code: "not_found",
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ candidates });
  } catch (e) {
    const quota = e instanceof UpstreamError ? e.quota : undefined;
    if (quota) {
      return NextResponse.json(
        {
          error: "OpenAlex 的每日请求额度已用完",
          hint: `免费额度是每天 1000 次请求,约 ${Math.max(0.1, quota.resetAfterSec / 3600).toFixed(1)} 小时后重置。已构建过的星空不受影响。`,
          code: "quota",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: "文献数据源暂时不可用",
        hint: e instanceof Error ? e.message : undefined,
        code: "upstream",
      },
      { status: 502 },
    );
  }
}
