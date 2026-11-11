/**
 * 模型用量 —— 按账号、按天持久化。
 *
 * 为什么不用内存计数:预算是「钱」,不能在重启或多实例之间各算各的。
 * 每账号一行,day 用本地日期字符串,避免数据库时区与用户看到的「今天」不一致。
 *
 * tokens 存 BIGINT;pg 驱动会以 string 返回,读出时统一转 Number。
 */

import { query, queryOne } from ".";

export interface DailyUsage {
  day: string;
  tokens: number;
  calls: number;
}

export function usageDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 默认每账号每天 40 万 token;失败时回退到安全默认值。 */
export function dailyTokenBudget(): number {
  const raw = Number(process.env.SAFETY_DAILY_TOKEN_BUDGET ?? "400000");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 400_000;
}

export async function readUsage(ownerId: string, day = usageDay()): Promise<DailyUsage> {
  const row = await queryOne<{ day: string; tokens: string; calls: number }>(
    "SELECT day, tokens, calls FROM usage_daily WHERE owner_id = $1 AND day = $2",
    [ownerId, day],
  );
  return {
    day,
    tokens: Number(row?.tokens ?? 0),
    calls: Number(row?.calls ?? 0),
  };
}

export async function recordUsage(ownerId: string, tokens: number, calls = 1): Promise<void> {
  const amount = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  const count = Number.isFinite(calls) ? Math.max(0, Math.round(calls)) : 0;
  if (!amount && !count) return;
  await query(
    `INSERT INTO usage_daily (owner_id, day, tokens, calls)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, day) DO UPDATE SET
       tokens = usage_daily.tokens + excluded.tokens,
       calls = usage_daily.calls + excluded.calls,
       updated_at = now()`,
    [ownerId, usageDay(), amount, count],
  );
}

/** 最近 N 天的用量,缺失的日期补 0,方便前端直接画贡献热力图。 */
export async function listUsage(ownerId: string, days = 7): Promise<DailyUsage[]> {
  const count = Math.max(1, Math.min(371, Math.floor(days)));
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (count - 1));
  const rows = await query<{ day: string; tokens: string; calls: number }>(
    "SELECT day, tokens, calls FROM usage_daily WHERE owner_id = $1 AND day >= $2 ORDER BY day DESC",
    [ownerId, usageDay(from)],
  );
  const byDay = new Map(
    rows.map((row) => [row.day, { day: row.day, tokens: Number(row.tokens), calls: Number(row.calls) }]),
  );
  const out: DailyUsage[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const day = usageDay(date);
    out.push(byDay.get(day) ?? { day, tokens: 0, calls: 0 });
  }
  return out;
}
