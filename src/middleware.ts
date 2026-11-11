/**
 * 页面与 API 的第一道门。
 *
 * 这里只做「有没有会话 Cookie」的粗筛,不查库 —— middleware 跑在 edge runtime,
 * 访问不到数据库。真正的校验在每个路由里(await requireUser),所以伪造一个 Cookie
 * 也只能看到一个空壳页面,拿不到任何数据。
 *
 * 这么分工的好处是:没登录的访问连一次数据库查询都不用付。
 */

import { NextResponse, type NextRequest } from "next/server";

/** 与会话模块里的常量保持一致;middleware 不能 import 服务端代码。 */
const SESSION_COOKIE = "stellarlit_session";

/** 首页是公开的:未登录用户也要先看到种子输入框,再由输入动作去登录。 */
const PUBLIC_PAGES = new Set(["/", "/login"]);
const PUBLIC_APIS = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/me",
  "/api/auth/logout",
  // 运维清理接口用自己的令牌鉴权,不能要求浏览器会话(Cron/脚本没有 Cookie)
  "/api/maintenance/cleanup",
  // MCP 是给外部客户端的,用自己的 Bearer token 鉴权,不走浏览器会话
  "/api/mcp",
];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PAGES.has(pathname)) return NextResponse.next();
  if (PUBLIC_APIS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (pathname.startsWith("/api/")) {
    if (!token) {
      return NextResponse.json(
        { error: "请先登录", code: "unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)"],
};
