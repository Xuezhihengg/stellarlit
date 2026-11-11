/**
 * 星空的持久化入口。
 *
 * 图谱产物本身是可重建的派生数据,但「用户存了哪几片星空」是需要长期保存的状态。
 * 这里把读写交给 Postgres 仓储(`server/db/starfields.ts`),Redis 只做短 TTL 读缓存:
 * 演示时同一片星空会被反复读取,没必要每次都反序列化几 MB 的 payload。
 *
 * 缓存按「账号 + 星空」建键:两个账号即使拿到同一个 id,也不会命中对方的副本。
 * 保存/删除时写穿 Redis,多个实例不会在写入前的旧副本上停留太久。
 */

import type { StarfieldPayload } from "@/types/api";
import type { StarfieldSummary } from "@/types/starfield";

import {
  deleteStarfieldRow,
  listStarfieldSummaries,
  loadStarfieldRow,
  saveStarfieldRow,
} from "../db/starfields";
import { deleteAskHistoryForStarfield } from "../db/ask-history";
import { serverConfig } from "../config";
import { cacheDel, cacheGet, cacheSet, redisKey } from "../redis";

const cacheKey = (ownerId: string, id: string): string =>
  redisKey("starfield", ownerId, id);

export async function saveStarfield(payload: StarfieldPayload, ownerId: string): Promise<boolean> {
  const key = cacheKey(ownerId, payload.starfield.id);
  try {
    await saveStarfieldRow(payload, ownerId);
    // 先落库再写缓存:数据库失败时不能让缓存里出现一份「没保存成功」的星空
    await cacheSet(key, payload, serverConfig.cache.starfieldTtlSec);
    return true;
  } catch {
    await cacheDel(key).catch(() => undefined);
    return false;
  }
}

export async function loadStarfield(id: string, ownerId: string): Promise<StarfieldPayload | null> {
  const key = cacheKey(ownerId, id);
  const hit = await cacheGet<StarfieldPayload>(key);
  if (hit) return hit;
  const payload = await loadStarfieldRow(id, ownerId);
  if (payload) await cacheSet(key, payload, serverConfig.cache.starfieldTtlSec);
  return payload;
}

export async function listStarfields(ownerId: string): Promise<StarfieldSummary[]> {
  try {
    return await listStarfieldSummaries(ownerId);
  } catch {
    // 列表是数据库的强项;Redis 只缓存单个 payload,不在故障时伪造一份不完整的列表
    return [];
  }
}

export async function deleteStarfield(id: string, ownerId: string): Promise<void> {
  await cacheDel(cacheKey(ownerId, id));
  // 历史里可能挂着图片对象,先删历史(内部会清媒体文件),再删星空
  await deleteAskHistoryForStarfield(ownerId, id).catch(() => 0);
  try {
    await deleteStarfieldRow(id, ownerId);
  } catch {
    /* 数据库不可用时至少内存里已经删掉 */
  }
}
