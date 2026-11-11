/**
 * Redis 客户端 —— 跨进程缓存、上游节流与短 TTL 状态都放这里。
 *
 * 之前的 Map 缓存有三个问题:没有上限、没有 TTL、多实例各存一份。
 * Redis 用 TTL 自动淘汰,所有实例读到同一份;连接失败时降级为「直接读源」,
 * 不会因为 Redis 暂时不可用把整站打挂。
 */

import Redis from "ioredis";

import { serverConfig } from "./config";

interface RedisGlobal {
  __stellarlitRedis?: Redis;
  __stellarlitRedisWarned?: boolean;
}

const globalForRedis = globalThis as typeof globalThis & RedisGlobal;

function client(): Redis {
  if (!globalForRedis.__stellarlitRedis) {
    const instance = new Redis(serverConfig.redis.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
      retryStrategy: (times) => Math.min(times * 250, 5_000),
    });
    instance.on("error", (error) => {
      if (globalForRedis.__stellarlitRedisWarned) return;
      globalForRedis.__stellarlitRedisWarned = true;
      console.warn(
        `[redis] 连接不可用(${error.message}),缓存降级为直读;确认 REDIS_URL 后重启即可恢复`,
      );
    });
    globalForRedis.__stellarlitRedis = instance;
  }
  return globalForRedis.__stellarlitRedis;
}

async function ready(): Promise<Redis | null> {
  const instance = client();
  const status = (): string => instance.status;
  if (status() === "ready") return instance;
  if (instance.status === "wait") {
    await instance.connect().catch(() => undefined);
  }
  return status() === "ready" ? instance : null;
}

export function redisKey(...parts: Array<string | number>): string {
  return [serverConfig.redis.prefix, ...parts.map(String)].join(":");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = await ready();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<boolean> {
  const redis = await ready();
  if (!redis) return false;
  try {
    await redis.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSec)));
    return true;
  } catch {
    return false;
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  const redis = await ready();
  if (!redis) return;
  await redis.del(...keys).catch(() => undefined);
}

/** 跨实例的上游节流门闩:SET NX PX 是原子的,不会出现两个实例同时放行。 */
const localHostHits = new Map<string, number>();
const LOCAL_HOST_LIMIT = 128;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function localThrottle(host: string, minIntervalMs: number): number {
  const now = Date.now();
  const prev = localHostHits.get(host) ?? 0;
  const wait = Math.max(0, minIntervalMs - (now - prev));
  if (!wait) {
    if (localHostHits.size >= LOCAL_HOST_LIMIT && !localHostHits.has(host)) {
      const oldest = localHostHits.keys().next().value;
      if (oldest) localHostHits.delete(oldest);
    }
    localHostHits.set(host, now);
  }
  return wait;
}

export async function waitForHostSlot(host: string, minIntervalMs: number): Promise<void> {
  const redis = await ready();
  if (!redis) {
    const wait = localThrottle(host, minIntervalMs);
    if (wait > 0) await sleep(wait);
    return;
  }

  const key = redisKey("throttle", host);
  try {
    const ok = await redis.set(key, "1", "PX", Math.max(1, minIntervalMs), "NX");
    if (ok === "OK") return;
    const ttl = await redis.pttl(key);
    if (ttl > 0) await sleep(Math.min(ttl, minIntervalMs));
  } catch {
    const wait = localThrottle(host, minIntervalMs);
    if (wait > 0) await sleep(wait);
  }
}

export interface RedisHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function redisHealth(): Promise<RedisHealth> {
  const startedAt = Date.now();
  const redis = await ready();
  if (!redis) return { ok: false, error: "Redis 未连接" };
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Redis 连接失败" };
  }
}

/** 脚本退出前释放连接;Web 进程里不需要调用。 */
export async function closeRedis(): Promise<void> {
  const instance = globalForRedis.__stellarlitRedis;
  if (!instance) return;
  globalForRedis.__stellarlitRedis = undefined;
  await instance.quit().catch(() => instance.disconnect());
}
