import { NextResponse } from "next/server";

import { userFromRequest } from "@/server/auth/require";

export const dynamic = "force-dynamic";

/** 未登录返回 user:null 而不是 401:登录页也要能问「我是谁」。 */
export async function GET(req: Request): Promise<Response> {
  return NextResponse.json({ user: await userFromRequest(req) });
}
