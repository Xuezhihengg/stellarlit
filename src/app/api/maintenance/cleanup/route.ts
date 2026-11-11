import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { runMaintenance } from "@/server/maintenance";

export const dynamic = "force-dynamic";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: Request): boolean {
  const expected = process.env.MAINTENANCE_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const auth = request.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : request.headers.get("x-maintenance-token")?.trim() ?? "";
  return Boolean(provided) && tokenMatches(provided, expected);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json(
      {
        error: "维护接口需要令牌。",
        hint: "设置 MAINTENANCE_TOKEN,并在请求头带上 Authorization: Bearer <token>。",
      },
      { status: 401 },
    );
  }
  return NextResponse.json(await runMaintenance());
}
