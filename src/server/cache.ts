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
};

const DEFAULT_FORMAT = "v1";

export function formatOf(namespace: string): string {
  return CACHE_FORMAT[namespace] ?? DEFAULT_FORMAT;
}

const CACHE_DIR = path.join(serverConfig.dataDir, "cache");

/** 把任意字符串变成安全的文件名:上游 ID 里可能带 `/` `:` 等字符。 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
}

export async function readCache<T>(namespace: string, key: string): Promise<T | null> {
  const file = path.join(CACHE_DIR, namespace, `${formatOf(namespace)}-${safeKey(key)}.json`);
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
  const file = path.join(dir, `${formatOf(namespace)}-${safeKey(key)}.json`);
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
