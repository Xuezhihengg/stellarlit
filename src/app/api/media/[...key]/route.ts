/**
 * 问答历史图片的只读出口。
 *
 * 对象 key 里带当前账号的命名空间哈希,登录后也只能读到自己的图;
 * 响应带私有长缓存:文件名是内容哈希,内容永远不会变。
 */

import { requireUser } from "@/server/auth/require";
import { readMedia } from "@/server/media/store";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ key: string[] }>;
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  const { key } = await ctx.params;
  const media = await readMedia(auth.user.id, key.join("/"));
  if (!media) {
    return Response.json({ error: "图片不存在" }, { status: 404 });
  }
  return new Response(media.data, {
    headers: {
      "Content-Type": media.mime,
      "Content-Length": String(media.data.byteLength),
      "Cache-Control": "private, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
