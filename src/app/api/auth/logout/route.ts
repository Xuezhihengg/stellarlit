import { NextResponse } from "next/server";

import { destroySession, isSecureRequest, SESSION_COOKIE } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) {
      await destroySession(decodeURIComponent(part.slice(index + 1).trim()));
      break;
    }
  }
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
