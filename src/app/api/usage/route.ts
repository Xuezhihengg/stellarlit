import { NextResponse } from "next/server";

import { requireUser } from "@/server/auth/require";
import { usageSnapshot } from "@/server/safety/limits";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await usageSnapshot(auth.user.id));
}
