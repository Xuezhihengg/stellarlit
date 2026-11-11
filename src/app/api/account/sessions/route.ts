import { NextResponse } from "next/server";

import { requireUser } from "@/server/auth/require";
import { destroyUserSessions, isSecureRequest, SESSION_COOKIE } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/** 退出所有设备(包括当前这台)。 */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  await destroyUserSessions(auth.user.id);
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
    maxAge: 0,
  });
  return response;
}
