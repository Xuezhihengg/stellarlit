/**
 * 请求限流与额度 —— 本地单进程实现,不引入 Redis。
 *
 * 三层控制,分别对应三种真实的滥用方式:
 *   1. 窗口限流:同一个人短时间连点几十次,防的是脚本;
 *   2. 并发上限:一次开十个流式请求,防的是把上游配额瞬间打光;
 *   3. 每日 token 预算:防的是「慢慢刷」—— 单次看着不多,一天下来账单失控。
 *
 * 失败一律返回可行动的信息(多久后重试、还剩多少),而不是一个 500。
 * 窗口/并发计数在进程内,重启归零;token 预算落在 PostgreSQL,按账号累计。
 */

import { dailyTokenBudget, readUsage, type DailyUsage } from "../db/usage";

export type LimitBucket =
  | "ask"
  | "grow"
  | "resolve"
  | "translate"
  | "health"
  | "mcp"
  | "auth";

interface BucketConfig {
  windowMs: number;
  /** 每个窗口允许的请求数 */
  max: number;
  /** 同一 key 同时进行的请求数上限 */
  concurrent: number;
}

const CONFIG: Record<LimitBucket, BucketConfig> = {
  ask: { windowMs: 10 * 60_000, max: 24, concurrent: 2 },
  grow: { windowMs: 10 * 60_000, max: 8, concurrent: 1 },
  resolve: { windowMs: 10 * 60_000, max: 20, concurrent: 2 },
  translate: { windowMs: 10 * 60_000, max: 40, concurrent: 3 },
  health: { windowMs: 10 * 60_000, max: 30, concurrent: 3 },
  mcp: { windowMs: 60_000, max: 120, concurrent: 4 },
  // 登录/注册:防撞库与批量注册。10 分钟 10 次对正常用户绰绰有余。
  auth: { windowMs: 10 * 60_000, max: 10, concurrent: 3 },
};

const hits = new Map<string, number[]>();
const running = new Map<string, number>();

/**
 * 客户端标识。部署在反向代理后面时用 x-forwarded-for 的第一跳;
 * 本地开发没有任何头,统一落到 local —— 这时限流依然是「全机共享」的,
 * 对单机演示是合理的。
 */
export function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

export interface LimitDecision {
  ok: boolean;
  code?: "rate_limited" | "too_many_running" | "budget_exhausted";
  message?: string;
  hint?: string;
  retryAfterSec?: number;
  remaining?: number;
}

export function checkLimit(req: Request, bucket: LimitBucket): LimitDecision {
  const config = CONFIG[bucket];
  const key = `${bucket}:${clientKey(req)}`;
  const now = Date.now();

  const active = running.get(key) ?? 0;
  if (active >= config.concurrent) {
    return {
      ok: false,
      code: "too_many_running",
      message: "上一条回答还在生成",
      hint: "等它结束或点停止后再问。并发上限用来保护上游模型配额。",
      retryAfterSec: 3,
    };
  }

  const recent = (hits.get(key) ?? []).filter((at) => now - at < config.windowMs);
  if (recent.length >= config.max) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000));
    hits.set(key, recent);
    return {
      ok: false,
      code: "rate_limited",
      message: "请求太频繁,先歇一会儿",
      hint: `每 ${Math.round(config.windowMs / 60_000)} 分钟最多 ${config.max} 次,约 ${Math.ceil(retryAfterSec / 60)} 分钟后恢复。`,
      retryAfterSec,
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // 顺手清理过期窗口,避免 Map 随访问 IP 无限增长。
  // 全部 key 都在窗口内时(例如被大量 IP 刷)也必须设硬上限,
  // 否则内存仍然只增不减;超限时丢弃最早插入的 key,相当于让最老的 IP 重新计数。
  if (hits.size > 512) {
    const longestWindow = Math.max(...Object.values(CONFIG).map((item) => item.windowMs));
    for (const [mapKey, stamps] of hits) {
      if (!stamps.length || now - (stamps[stamps.length - 1] as number) > longestWindow) {
        hits.delete(mapKey);
      }
    }
  }
  while (hits.size > 1024) {
    const oldest = hits.keys().next().value;
    if (!oldest) break;
    hits.delete(oldest);
  }

  return { ok: true, remaining: Math.max(0, config.max - recent.length) };
}

/** 开始一次重请求:占用并发位,返回释放函数。 */
export function beginRun(req: Request, bucket: LimitBucket): () => void {
  const key = `${bucket}:${clientKey(req)}`;
  running.set(key, (running.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = Math.max(0, (running.get(key) ?? 1) - 1);
    if (next === 0) running.delete(key);
    else running.set(key, next);
  };
}

export interface BudgetSnapshot extends DailyUsage {
  budget: number;
  remaining: number;
  /** 0–100,用于界面进度条;超预算时保留 100 以上由调用方决定怎么显示 */
  percent: number;
}

export async function usageSnapshot(ownerId: string): Promise<BudgetSnapshot> {
  const usage = await readUsage(ownerId);
  const budget = dailyTokenBudget();
  return {
    ...usage,
    budget,
    remaining: Math.max(0, budget - usage.tokens),
    percent: budget > 0 ? Math.round((usage.tokens / budget) * 1000) / 10 : 100,
  };
}

export interface BudgetDecision {
  ok: boolean;
  code?: "budget_exhausted";
  message?: string;
  hint?: string;
  snapshot: BudgetSnapshot;
}

/** 模型调用前检查当前账号的当日预算。 */
export async function checkBudget(ownerId: string): Promise<BudgetDecision> {
  const snapshot = await usageSnapshot(ownerId);
  if (snapshot.tokens >= snapshot.budget) {
    return {
      ok: false,
      code: "budget_exhausted",
      message: "当前账号今天的 token 预算已用完",
      hint: `已用约 ${Math.round(snapshot.tokens / 1000)}k / ${Math.round(
        snapshot.budget / 1000,
      )}k token。明天自动重置,或由管理员调高 SAFETY_DAILY_TOKEN_BUDGET。`,
      snapshot,
    };
  }
  return { ok: true, snapshot };
}

/** 测试用:清空进程内限流计数,避免用例之间互相影响。 */
export function resetLimits(): void {
  hits.clear();
  running.clear();
}
