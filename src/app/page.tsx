import { Workspace } from "@/components/home/Workspace";

export const dynamic = "force-dynamic";

/**
 * 站点入口。
 *
 * `/` 本身是公开的:未登录用户也应该先看到品牌与种子输入框,
 * 而不是被直接甩到登录表单。是否登录交给客户端 workspace 判断,
 * 真正需要账号的数据仍在各自的 API 路由里校验。
 *
 * `?starfield=` 是历史页与刷新恢复用的深链,直接以画布为初始视图,
 * 避免先闪一下首页再切过去。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const starfield =
    typeof params.starfield === "string" && params.starfield.trim()
      ? params.starfield.trim()
      : null;
  const seed = typeof params.seed === "string" ? params.seed.slice(0, 300) : "";

  return (
    <Workspace
      initialStarfieldId={starfield}
      initialSeed={seed}
      autoStart={params.auto === "1"}
    />
  );
}
