import { redirect } from "next/navigation";

import { LoginForm } from "./LoginForm";
import { currentUser } from "@/server/auth/require";

export const dynamic = "force-dynamic";

/** 登录 / 注册。已经登录的人不该再看到这一页。 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await currentUser();
  const { next } = await searchParams;
  if (user) redirect(next && next.startsWith("/") ? next : "/");

  return <LoginForm next={next && next.startsWith("/") ? next : "/"} />;
}
