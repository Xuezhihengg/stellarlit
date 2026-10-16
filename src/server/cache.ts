/**
 * 落盘缓存 —— 把重活的结果留在 data/cache/ 下。
 *
 * 为什么必须有:答辩现场的网络不可控,而「从种子论文长出一张星图」是重活
 * (几十到几百次 API 请求 + 社区检测 + 布局)。跑一次存下来,演示时秒开、可离线。
 *
 * 写盘是 best-effort:部署到只读文件系统时静默跳过,不影响功能本身。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { serverConfig } from "./config";

/**
 * 缓存格式版本。载荷结构一变就必须改这里。
 *
 * 这条规则来自一次真实事故:老的单种子载荷缺了新增字段,
 * 旧缓存被当新格式读出来,界面上出现一整片 `undefined` 的节点。
 * 带版本号比「记得手工删缓存」可靠得多。
 */
export const CACHE_FORMAT = "v2";

const CACHE_DIR = path.join(serverConfig.dataDir, "cache");

/** 把任意字符串变成安全的文件名:上游 ID 里可能带 `/` `:` 等字符。 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
}

export async function readCache<T>(namespace: string, key: string): Promise<T | null> {
  const file = path.join(CACHE_DIR, namespace, `${CACHE_FORMAT}-${safeKey(key)}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
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
  const file = path.join(dir, `${CACHE_FORMAT}-${safeKey(key)}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(payload), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取缓存,未命中则执行计算并写回。
 *
 * 加一层内存缓存:同一进程内重复构建同一片星空时,不必反复读盘与解析 JSON。
 * 演示时最坏的情况是"点了两次同一个种子",这一层就够了。
 */
const memory = new Map<string, unknown>();

export async function cached<T>(
  namespace: string,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const memoKey = `${namespace}:${key}`;
  const hit = memory.get(memoKey);
  if (hit !== undefined) return hit as T;

  const fromDisk = await readCache<T>(namespace, key);
  if (fromDisk !== null) {
    memory.set(memoKey, fromDisk);
    return fromDisk;
  }

  const value = await compute();
  memory.set(memoKey, value);
  void writeCache(namespace, key, value);
  return value;
}
