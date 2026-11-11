/**
 * 有上限的 JSON 请求体读取。
 *
 * `req.json()` 会先把整个请求体读进内存,再交给 schema 校验 —— 等 schema 说
 * 「最多 4 张图」时,内存已经被占完了。这里先看 Content-Length,没有就按块
 * 读取并在超过上限时立刻中断,保证任何路由都不会被超大请求拖垮。
 */

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: "bad_json" | "payload_too_large"; error: string };

function tooLarge(maxBytes: number): JsonBodyResult {
  return {
    ok: false,
    status: 413,
    code: "payload_too_large",
    error: `请求体超过 ${Math.round(maxBytes / 1024)}KB 上限`,
  };
}

export async function readJsonLimited(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge(maxBytes);

  if (!req.body) {
    return { ok: false, status: 400, code: "bad_json", error: "请求体为空" };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, code: "bad_json", error: "请求体读取失败" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) {
      return { ok: false, status: 400, code: "bad_json", error: "请求体为空" };
    }
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, code: "bad_json", error: "请求体不是有效 JSON" };
  }
}

/** 常规表单 / 设置类请求:字段都很短,64KB 足够。 */
export const SMALL_JSON_BYTES = 64 * 1024;

/** 问答请求:4 张 4MB 图片转 base64 后约 22MB,给一点 JSON 包装余量。 */
export const ASK_JSON_BYTES = 24 * 1024 * 1024;

/** 历史保存:4 张 240px 缩略图 + 文本,512KB 足够;原图不应出现在这里。 */
export const HISTORY_JSON_BYTES = 512 * 1024;
