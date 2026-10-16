/**
 * 极简 HTTP 客户端 —— 只做真实管道必须的三件事:
 * 超时、重试(指数退避)、同一主机的请求间隔。
 *
 * 为什么要限速:arXiv 官方要求「每 3 秒最多一次请求」,OpenAlex 有礼貌池。
 * 一个会被封的爬虫不是工程,是事故。
 */

import { serverConfig } from "./config";

/** 同一主机上一次请求的时间戳。模块级 Map 即可 —— 单进程内限速足够。 */
const lastHitAt = new Map<string, number>();

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
  ) {
    super(message);
    this.name = "UpstreamError";
  }
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
    const prev = lastHitAt.get(host) ?? 0;
    const wait = minIntervalMs - (Date.now() - prev);
    if (wait > 0) await sleep(wait);
    lastHitAt.set(host, Date.now());

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { "user-agent": serverConfig.userAgent, accept: "*/*", ...headers },
        signal: ac.signal,
      });
      // 429 / 5xx 值得重试;其余 4xx 再试也不会有不同结果
      if (res.status === 429 || res.status >= 500) {
        throw new UpstreamError(`HTTP ${res.status}`, url, res.status);
      }
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status} ${res.statusText}`, url, res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
      // 明确的上游 4xx(非 429)不重试:重试只是浪费配额
      if (e instanceof UpstreamError && e.status && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await sleep(700 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new UpstreamError(
    `请求失败 —— ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    url,
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
