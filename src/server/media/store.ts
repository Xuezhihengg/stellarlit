/**
 * 内容寻址的对象存储(本地实现)。
 *
 * 问答历史里的图片预览不能以 base64 塞进 JSONB:一条 4 张图就能让行体积膨胀
 * 到几百 KB,列表查询、备份和 WAL 都会跟着变重。这里把预览写成独立文件,
 * 数据库只保存 `/api/media/...` 路径。
 *
 * key = ask/<owner 哈希>/<内容哈希>.<ext>
 *   - 内容哈希天然去重:同一张图反复提问只占一份;
 *   - owner 哈希放进路径,读取时校验前缀,别的账号拿到 key 也读不到;
 *   - 目录按内容寻址,换成 S3/OSS 时只需要替换这一层。
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { serverConfig } from "../config";

const MEDIA_ROOT = path.join(serverConfig.dataDir, "media");
const ASK_NAMESPACE = "ask";

/** 单张预览 96KB、一次最多 4 张,总上限 320KB。客户端会先缩到 240px。 */
export const MAX_PREVIEW_BYTES = 96 * 1024;
export const MAX_PREVIEW_TOTAL_BYTES = 320 * 1024;
export const MAX_PREVIEWS = 4;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export function ownerNamespace(ownerId: string): string {
  return createHash("sha256").update(`owner:${ownerId}`).digest("hex").slice(0, 20);
}

export function mediaUrl(key: string): string {
  return `/api/media/${key}`;
}

/** 从 `/api/media/...` 或裸 key 里取回对象 key;外部 URL 一律不认。 */
export function keyFromUrl(value: string): string | null {
  const raw = value.startsWith("/api/media/") ? value.slice("/api/media/".length) : value;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function isOwnAskKey(ownerId: string, key: string): boolean {
  return key.startsWith(`${ASK_NAMESPACE}/${ownerNamespace(ownerId)}/`);
}

function resolveKeyPath(key: string): string | null {
  const parts = key.split("/");
  if (!parts.length) return null;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part)) return null;
  }
  const file = path.join(MEDIA_ROOT, ...parts);
  if (!file.startsWith(`${MEDIA_ROOT}${path.sep}`)) return null;
  return file;
}

function looksLikeImage(mime: string, data: Buffer): boolean {
  if (mime === "image/jpeg") return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/webp") {
    return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (mime === "image/gif") return data.subarray(0, 4).toString("ascii") === "GIF8";
  return false;
}

async function writeObject(key: string, data: Buffer): Promise<void> {
  const file = resolveKeyPath(key);
  if (!file) throw new Error("图片 key 不合法");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await stat(file);
    return;
  } catch {
    // 不存在才写
  }
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

/**
 * 把客户端传来的 `data:image/...;base64,...` 预览落盘,返回对象 key。
 * 只接受四种图片 MIME,且会校验文件头,避免把任意二进制伪装成图片存进来。
 */
export async function saveAskPreviews(ownerId: string, dataUrls: string[]): Promise<string[]> {
  if (!dataUrls.length) return [];
  if (dataUrls.length > MAX_PREVIEWS) throw new Error(`最多保存 ${MAX_PREVIEWS} 张图片预览`);
  let total = 0;
  const keys: string[] = [];
  for (const url of dataUrls) {
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new Error("图片预览格式不正确");
    const mime = match[1] as keyof typeof MIME_EXT;
    const data = Buffer.from(match[2] ?? "", "base64");
    if (!data.length || data.length > MAX_PREVIEW_BYTES) {
      throw new Error(`单张图片预览不能超过 ${Math.round(MAX_PREVIEW_BYTES / 1024)}KB`);
    }
    if (!looksLikeImage(mime, data)) throw new Error("图片内容与类型不匹配");
    total += data.length;
    if (total > MAX_PREVIEW_TOTAL_BYTES) {
      throw new Error("图片预览总大小超限");
    }
    const digest = createHash("sha256").update(data).digest("hex");
    const key = `${ASK_NAMESPACE}/${ownerNamespace(ownerId)}/${digest}.${MIME_EXT[mime]}`;
    await writeObject(key, data);
    keys.push(key);
  }
  return keys;
}

export interface StoredMedia {
  data: ArrayBuffer;
  mime: string;
}

/** 读取自己的对象;key 前缀不匹配时返回 null,对外表现为 404。 */
export async function readMedia(ownerId: string, key: string): Promise<StoredMedia | null> {
  if (!isOwnAskKey(ownerId, key)) return null;
  const file = resolveKeyPath(key);
  if (!file) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  try {
    const data = await readFile(file);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return { data: copy.buffer, mime: EXT_MIME[ext] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** 删除一组对象;只删当前账号命名空间下的,失败静默。 */
export async function deleteMediaKeys(ownerId: string, keys: string[]): Promise<number> {
  let deleted = 0;
  for (const key of new Set(keys)) {
    if (!isOwnAskKey(ownerId, key)) continue;
    const file = resolveKeyPath(key);
    if (!file) continue;
    try {
      await unlink(file);
      deleted++;
    } catch {
      // 已被别的历史引用或已删除:保持幂等
    }
  }
  return deleted;
}

interface MediaFile {
  key: string;
  file: string;
  size: number;
  mtimeMs: number;
}

async function walk(dir: string, root: string): Promise<MediaFile[]> {
  const out: MediaFile[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, root)));
    } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
      try {
        const info = await stat(full);
        out.push({
          key: path.relative(root, full).split(path.sep).join("/"),
          file: full,
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // 遍历期间被删掉
      }
    }
  }
  return out;
}

export interface MediaPruneResult {
  scanned: number;
  deleted: number;
  bytesFreed: number;
}

/**
 * 删除没有历史引用的图片对象。
 *
 * 只处理超过 `maxAgeMs` 的文件:刚写入、还没来得及提交数据库的竞态对象不能删。
 * 正常情况下删除历史会同步清文件,这里是兜底(例如进程在事务提交后崩溃)。
 */
export async function pruneOrphanMedia(options: {
  referenced: Set<string>;
  maxAgeMs: number;
}): Promise<MediaPruneResult> {
  const files = await walk(path.join(MEDIA_ROOT, ASK_NAMESPACE), MEDIA_ROOT);
  const cutoff = Date.now() - options.maxAgeMs;
  let deleted = 0;
  let bytesFreed = 0;
  for (const item of files) {
    if (options.referenced.has(item.key) || item.mtimeMs >= cutoff) continue;
    try {
      await unlink(item.file);
      deleted++;
      bytesFreed += item.size;
    } catch {
      // 另一个实例已经删了
    }
  }
  return { scanned: files.length, deleted, bytesFreed };
}
