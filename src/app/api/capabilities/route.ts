import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/require";

import { capabilityReport } from "@/server/model-settings";

/**
 * 服务端能力探测。
 *
 * 前端必须知道「现在有没有大模型」,才能在界面上如实区分
 * 「AI 判定」与「启发式判定」—— 缺密钥时假装有 AI 结论是不可接受的。
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await capabilityReport(auth.user.id));
}
