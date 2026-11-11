/**
 * 极简 HTTP 客户端 —— 只做真实管道必须的三件事:
 * 超时、重试(指数退避)、同一主机的请求间隔。
 *
 * 为什么要限速:arXiv 官方要求「每 3 秒最多一次请求」,OpenAlex 有礼貌池。
 * 一个会被封的爬虫不是工程,是事故。
 */

import { serverConfig } from "./config";
import { waitForHostSlot } from "./redis";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  /** 同一主机两次请求的最小间隔 */
  minIntervalMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
    /**
     * 配额被用尽时的时间信息。
     *
     * 这类失败和"网络抖动"必须分开处理:前者重试几十次也没用,
     * 而且每次重试都在提醒上游"这个客户端还在硬打"。实测 OpenAlex
     * 的免费额度是按天算的 1000 次,用尽后 reset 在十几小时之后 ——
     * 对它做指数退避重试是纯粹的浪费,还会把真实原因(额度用尽)
     * 伪装成"数据源暂时不可用",让人以为是网络问题。
     */
    readonly quota?: { resetAfterSec: number },
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** 从响应头里读配额信息。上游不一定给,所以每个字段都要能缺省。 */
function readQuota(res: Response): { exhausted: boolean; resetAfterSec: number } {
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
  const retryAfter = Number(res.headers.get("retry-after") ?? "0");
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0");
  return {
    exhausted: Number.isFinite(remaining) && remaining <= 0,
    resetAfterSec: Math.max(retryAfter, reset, 0),
  };
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const {
    timeoutMs = 25_000,
    retries = 3,
    minIntervalMs = 350,
    headers = {},
    method,
    body,
  } = opts;

  const host = new URL(url).host;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Redis SET NX PX 做跨实例节流;Redis 不可用时退回有上限的进程内表
    await waitForHostSlot(host, minIntervalMs);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { "user-agent": serverConfig.userAgent, accept: "*/*", ...headers },
        signal: ac.signal,
      });
      if (res.status === 429) {
        const quota = readQuota(res);
        // 额度用尽:立即失败,不重试。重试只会在十几小时的等待里多打几十次
        if (quota.exhausted || quota.resetAfterSec > 120) {
          throw new UpstreamError(
            `配额已用尽(${Math.round(quota.resetAfterSec / 60)} 分钟后重置)`,
            url,
            429,
            { resetAfterSec: quota.resetAfterSec },
          );
        }
        throw new UpstreamError("HTTP 429", url, 429);
      }
      // 5xx 值得重试;其余 4xx 再试也不会有不同结果
      if (res.status >= 500) throw new UpstreamError(`HTTP ${res.status}`, url, res.status);
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status} ${res.statusText}`, url, res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
      // 配额用尽与明确的上游 4xx 都不重试:重试只是浪费配额与时间
      if (e instanceof UpstreamError && e.quota) break;
      if (e instanceof UpstreamError && e.status && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await sleep(700 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 重抛时要**带上原始错误的结构**,而不是只留一句话。
   *
   * 这里一度只取了 message,于是配额信息(quota)、状态码(429)全被丢掉,
   * 上层拿到的就只是一个普通失败 —— 明明检测出了"额度用尽、975 分钟后重置",
   * 到用户面前又变回了含糊的"数据源暂时不可用"。
   */
  const carry = lastErr instanceof UpstreamError ? lastErr : null;
  throw new UpstreamError(
    `请求失败 —— ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    url,
    carry?.status,
    carry?.quota,
  );
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError("上游返回的不是合法 JSON", url);
  }
}
