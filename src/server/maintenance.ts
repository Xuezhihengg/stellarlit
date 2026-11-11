/**
 * 后台清理 —— 会话、图像分析缓存、磁盘缓存。
 *
 * 三者的共同点是「读的时候不会自然归零」:过期会话、久未命中的图像分析、
 * 历史邻域 JSON 都会一直躺在存储里。这里在进程启动时跑一次,之后按间隔重复;
 * 同一进程只启动一个循环,避免 dev 热重载叠加多个 timer。
 */

import { pruneExpiredSessions } from "./auth/session";
import { pruneDiskCache, type DiskCachePruneResult } from "./cache";
import { serverConfig } from "./config";
import { listAskHistoryImageKeys } from "./db/ask-history";
import { pruneOrphanMedia, type MediaPruneResult } from "./media/store";
import { pruneImageIndexCache, type ImageCachePruneResult } from "./rag/image-index";
import { redisHealth, type RedisHealth } from "./redis";

export interface MaintenanceResult {
  startedAt: string;
  durationMs: number;
  sessionsDeleted: number;
  imageCache: ImageCachePruneResult | null;
  diskCache: DiskCachePruneResult | null;
  media: MediaPruneResult | null;
  redis: RedisHealth;
  errors: string[];
}

export async function runMaintenance(): Promise<MaintenanceResult> {
  const started = Date.now();
  const errors: string[] = [];

  const [sessions, images, disk, media, redis] = await Promise.allSettled([
    pruneExpiredSessions(),
    pruneImageIndexCache(),
    pruneDiskCache(),
    listAskHistoryImageKeys().then((keys) =>
      // 只清 24 小时前的孤儿,避免删掉「文件写完、事务还没提交」的竞态对象
      pruneOrphanMedia({ referenced: new Set(keys), maxAgeMs: 24 * 60 * 60 * 1000 }),
    ),
    redisHealth(),
  ]);

  if (sessions.status === "rejected") {
    errors.push(`会话清理失败:${String(sessions.reason)}`);
  }
  if (images.status === "rejected") {
    errors.push(`图像缓存清理失败:${String(images.reason)}`);
  }
  if (disk.status === "rejected") {
    errors.push(`磁盘缓存清理失败:${String(disk.reason)}`);
  }
  if (media.status === "rejected") {
    errors.push(`图片对象清理失败:${String(media.reason)}`);
  }

  return {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    sessionsDeleted: sessions.status === "fulfilled" ? sessions.value : 0,
    imageCache: images.status === "fulfilled" ? images.value : null,
    diskCache: disk.status === "fulfilled" ? disk.value : null,
    media: media.status === "fulfilled" ? media.value : null,
    redis:
      redis.status === "fulfilled"
        ? redis.value
        : { ok: false, error: String(redis.reason) },
    errors,
  };
}

interface MaintenanceGlobal {
  __stellarlitMaintenanceStarted?: boolean;
}

const globalForMaintenance = globalThis as typeof globalThis & MaintenanceGlobal;

/** 启动时延时跑一次(等迁移就绪),之后按 MAINTENANCE_INTERVAL_MIN 重复。 */
export function startMaintenanceLoop(): void {
  if (globalForMaintenance.__stellarlitMaintenanceStarted) return;
  globalForMaintenance.__stellarlitMaintenanceStarted = true;

  const run = () => {
    void runMaintenance()
      .then((result) => {
        const summary = [
          `会话 ${result.sessionsDeleted}`,
          `图像 ${result.imageCache?.deleted ?? 0}`,
          `磁盘 ${result.diskCache?.deleted ?? 0} 个文件`,
          `图片 ${result.media?.deleted ?? 0} 个对象`,
          `Redis ${result.redis.ok ? `${result.redis.latencyMs}ms` : "不可用"}`,
        ].join(" · ");
        console.info(`[maintenance] ${summary}(${result.durationMs}ms)`);
        for (const error of result.errors) console.warn(`[maintenance] ${error}`);
      })
      .catch((error: unknown) => {
        console.warn("[maintenance] 清理失败:", error instanceof Error ? error.message : String(error));
      });
  };

  const timer = setTimeout(run, 2_000);
  timer.unref?.();
  const interval = setInterval(run, serverConfig.cache.maintenanceIntervalMs);
  interval.unref?.();
}
