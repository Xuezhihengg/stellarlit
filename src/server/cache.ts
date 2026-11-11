/**
 * 落盘缓存 —— 把重活的结果留在 data/cache/ 下。
 *
 * 为什么必须有:答辩现场的网络不可控,而「从种子论文长出一张星图」是重活
 * (几十到几百次 API 请求 + 社区检测 + 布局)。跑一次存下来,演示时秒开、可离线。
 *
 * 写盘是 best-effort:部署到只读文件系统时静默跳过,不影响功能本身。
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { serverConfig } from "./config";
import { cacheGet, cacheSet, redisKey } from "./redis";

/**
 * 缓存格式版本 —— **按命名空间分开**。
 *
 * 这条规则来自一次真实事故:老的单种子载荷缺了新增字段,旧缓存被当新格式
 * 读出来,界面上出现一整片 `undefined` 的节点。所以必须有版本号。
 *
 * 但版本号不该是全局的:邻域缓存装的是**上游原始数据**,形状几年不变;
 * 图谱载荷的形状却每轮迭代都在动。共用一个版本号的代价是 ——
 * 改一次图谱结构,全部邻域缓存同时失效,下一次建图要把几百次上游请求
 * 重打一遍。实测就是这么把 OpenAlex 的每日额度烧光的。
 *
 * 所以:各管各的版本。改哪一层的形状,才动哪一层的版本号。
 */
const CACHE_FORMAT: Record<string, string> = {
  /** 上游原始邻域。形状 = OpenAlex 的响应,稳定 */
  neighborhood: "v2",
  /** 关系判定结论。键里已经带了 promptVersion,这里只在结构变化时才动 */
  relations: "v2",
  /** 多标签判定结论:一对论文一次调用,值为该对成立的标签数组 */
  "relation-labels": "v1",
};

const DEFAULT_FORMAT = "v1";

export function formatOf(namespace: string): string {
  return CACHE_FORMAT[namespace] ?? DEFAULT_FORMAT;
}

const CACHE_DIR = path.join(serverConfig.dataDir, "cache");

/** 命名空间级 TTL:上游邻域 7 天、关系结论 30 天,过期后由 Redis 自动淘汰。 */
const NAMESPACE_TTL_SEC: Record<string, number> = {
  neighborhood: 7 * 24 * 60 * 60,
  relations: 30 * 24 * 60 * 60,
  "relation-labels": 30 * 24 * 60 * 60,
};

function ttlOf(namespace: string): number {
  return NAMESPACE_TTL_SEC[namespace] ?? serverConfig.cache.defaultTtlSec;
}

function redisCacheKey(namespace: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return redisKey("cache", namespace, formatOf(namespace), digest);
}

/** 把任意字符串变成安全的文件名:上游 ID 里可能带 `/` `:` 等字符。 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
}

export async function readCache<T>(namespace: string, key: string): Promise<T | null> {
  const redisKeyValue = redisCacheKey(namespace, key);
  const fromRedis = await cacheGet<T>(redisKeyValue);
  if (fromRedis !== null) return fromRedis;

  const file = path.join(CACHE_DIR, namespace, `${formatOf(namespace)}-${safeKey(key)}.json`);
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as T;
    // 回填 Redis:磁盘保留跨重启能力,Redis 负责跨实例与低延迟
    await cacheSet(redisKeyValue, value, ttlOf(namespace));
    return value;
  } catch {
    return null;
  }
}

export async function writeCache(
  namespace: string,
  key: string,
  payload: unknown,
): Promise<boolean> {
  const dir = path.join(CACHE_DIR, namespace);
  const file = path.join(dir, `${formatOf(namespace)}-${safeKey(key)}.json`);
  const redisOk = await cacheSet(redisCacheKey(namespace, key), payload, ttlOf(namespace));
  try {
    await mkdir(dir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify(payload), "utf8");
    await rename(temp, file);
    return true;
  } catch {
    return redisOk;
  }
}

export async function cached<T>(
  namespace: string,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(redisCacheKey(namespace, key));
  if (hit !== null) return hit;

  const fromDisk = await readCache<T>(namespace, key);
  if (fromDisk !== null) return fromDisk;

  const value = await compute();
  void writeCache(namespace, key, value);
  return value;
}

interface CacheFile {
  file: string;
  size: number;
  mtimeMs: number;
}

async function walk(dir: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      try {
        const info = await stat(full);
        out.push({ file: full, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // 文件在遍历期间被删掉:忽略
      }
    }
  }
  return out;
}

export interface DiskCachePruneResult {
  scanned: number;
  deleted: number;
  bytesFreed: number;
  remainingBytes: number;
}

/**
 * 磁盘缓存清理:先删过期文件,再按最旧优先删到容量上限以内。
 * 只碰 `data/cache/` 下的 JSON,不会动星空存档。
 */
export async function pruneDiskCache(options?: {
  maxBytes?: number;
  maxAgeMs?: number;
}): Promise<DiskCachePruneResult> {
  const maxBytes = options?.maxBytes ?? serverConfig.cache.diskMaxBytes;
  const maxAgeMs = options?.maxAgeMs ?? serverConfig.cache.diskMaxAgeMs;
  const files = (await walk(CACHE_DIR)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const total = files.reduce((sum, item) => sum + item.size, 0);
  const cutoff = Date.now() - maxAgeMs;
  const doomed = new Set<string>();
  let remainingBytes = total;

  for (const item of files) {
    if (item.mtimeMs < cutoff) {
      doomed.add(item.file);
      remainingBytes -= item.size;
    }
  }
  for (const item of files) {
    if (remainingBytes <= maxBytes) break;
    if (doomed.has(item.file)) continue;
    doomed.add(item.file);
    remainingBytes -= item.size;
  }

  let deleted = 0;
  let bytesFreed = 0;
  for (const item of files) {
    if (!doomed.has(item.file)) continue;
    try {
      await unlink(item.file);
      deleted++;
      bytesFreed += item.size;
    } catch {
      remainingBytes += item.size;
    }
  }
  return {
    scanned: files.length,
    deleted,
    bytesFreed,
    remainingBytes: Math.max(0, remainingBytes),
  };
}
