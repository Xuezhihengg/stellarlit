/**
 * 服务端配置 —— 所有环境变量的唯一读取点。
 *
 * 为什么集中在一处:密钥绝不能散落在各个模块里被 `process.env.X` 随手取用 ——
 * 那样既无法确认"到底哪里在用密钥",也无法在缺少密钥时统一降级。
 *
 * 降级策略:没有密钥不是错误,而是「能力不可用」。
 * 结构层(引用、作者、发表)来自免费数据源,不需要任何密钥;
 * 只有语义层(关系判定、检索问答)需要大模型。缺密钥时该能力降级为
 * 启发式判定,并在界面上如实标注 —— 而不是假装有结果。
 */

import path from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export interface ServerConfig {
  dataDir: string;
  /** 写进 User-Agent 的客户端标识。 */
  userAgent: string;
  redis: {
    url: string;
    prefix: string;
  };
  cache: {
    /** 通用缓存默认 TTL;按命名空间可覆盖。 */
    defaultTtlSec: number;
    /** 星空 payload 很大,TTL 短一些,靠写穿保证多实例一致。 */
    starfieldTtlSec: number;
    /** 单张星图的 JSON 体积上限;超过通常是异常膨胀,应拒绝而不是写进库。 */
    starfieldMaxBytes: number;
    /** data/cache 磁盘上限与最长保留时间。 */
    diskMaxBytes: number;
    diskMaxAgeMs: number;
    /** image_index_cache 的保留行数与最长空闲时间。 */
    imageMaxRows: number;
    imageMaxAgeMs: number;
    /** 后台清理间隔。 */
    maintenanceIntervalMs: number;
  };
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(env(name));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export const serverConfig: ServerConfig = {
  dataDir: env("STELLARLIT_DATA_DIR") ?? path.join(process.cwd(), "data"),
  userAgent: "StellarLit/0.1 (academic star map)",
  redis: {
    url: env("REDIS_URL") ?? "redis://localhost:6379",
    prefix: env("REDIS_PREFIX") ?? "stellarlit",
  },
  cache: {
    defaultTtlSec: intEnv("CACHE_TTL_SEC", 24 * 60 * 60),
    starfieldTtlSec: intEnv("STARFIELD_CACHE_TTL_SEC", 10 * 60),
    diskMaxBytes: intEnv("DISK_CACHE_MAX_MB", 256) * 1024 * 1024,
    diskMaxAgeMs: intEnv("DISK_CACHE_MAX_AGE_DAYS", 30) * 24 * 60 * 60 * 1000,
    starfieldMaxBytes: intEnv("STARFIELD_MAX_MB", 8) * 1024 * 1024,
    imageMaxRows: intEnv("IMAGE_CACHE_MAX_ROWS", 2000),
    imageMaxAgeMs: intEnv("IMAGE_CACHE_MAX_AGE_DAYS", 30) * 24 * 60 * 60 * 1000,
    maintenanceIntervalMs: intEnv("MAINTENANCE_INTERVAL_MIN", 6 * 60) * 60 * 1000,
  },
};
