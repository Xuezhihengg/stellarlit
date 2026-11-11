/**
 * 问答历史仓储(PostgreSQL)。
 *
 * 历史是用户资产:服务端保存后,同一片星空的历史可以在任何设备继续读。
 * 每片星空只保留最近 50 条,写入时顺手裁剪,不需要定时任务。
 *
 * 存储分三层,避免「一条历史把整张表拖重」:
 *   - ask_history         热字段:id / 问题 / 回答 / 时间 / 图片 key
 *   - ask_history_details 冷字段:来源、Agent 轨迹、决策、图像证据
 *   - data/media          图片预览对象,库里只留内容寻址 key
 *
 * 列表只读热表并截断回答;点开某一条时才取详情,再按 key 拼出图片 URL。
 */

import type { AskHistoryEntry, AskHistorySummary } from "@/types/rag";

import { deleteMediaKeys, mediaUrl, saveAskPreviews } from "../media/store";
import { query, queryOne, transaction } from ".";

const MAX_PER_STARFIELD = 50;
const MAX_DETAIL_BYTES = 512 * 1024;
const SUMMARY_ANSWER_CHARS = 280;

/**
 * 内容寻址会去重:两条历史可能引用同一个图片 key。
 * 删除前必须确认库里已经没有任何行引用它,否则会把另一条的预览删掉。
 */
async function deleteUnreferencedMedia(ownerId: string, keys: string[]): Promise<number> {
  const unique = [...new Set(keys)];
  if (!unique.length) return 0;
  const stillUsed = await query<{ key: string }>(
    `SELECT DISTINCT unnest(image_keys) AS key
     FROM ask_history WHERE owner_id = $1 AND image_keys && $2::text[]`,
    [ownerId, unique],
  );
  const referenced = new Set(stillUsed.map((row) => row.key));
  const removable = unique.filter((key) => !referenced.has(key));
  return removable.length ? deleteMediaKeys(ownerId, removable) : 0;
}

interface SummaryRow {
  id: string;
  question: string;
  answer: string;
  created_at: string | number;
  image_count: number;
}

interface DetailRow extends SummaryRow {
  image_keys: string[];
  payload: Record<string, unknown>;
}

function toEntry(row: DetailRow): AskHistoryEntry {
  const rest: Record<string, unknown> = { ...(row.payload ?? {}) };
  for (const key of ["id", "createdAt", "question", "answer", "imagePreviews"]) {
    delete rest[key];
  }
  const keys = row.image_keys ?? [];
  return {
    ...rest,
    id: row.id,
    createdAt: Number(row.created_at),
    question: row.question,
    answer: row.answer,
    imageCount: keys.length || (typeof rest.imageCount === "number" ? rest.imageCount : undefined),
    imagePreviews: keys.length ? keys.map(mediaUrl) : undefined,
  } as AskHistoryEntry;
}

function toSummary(row: SummaryRow): AskHistorySummary {
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    question: row.question,
    answer: row.answer,
    imageCount: Number(row.image_count) || undefined,
  };
}

export async function saveAskHistoryEntry(
  ownerId: string,
  starfieldId: string,
  entry: AskHistoryEntry,
): Promise<void> {
  const { id, createdAt, question, answer, imagePreviews, ...rest } = entry;
  // 客户端传的是压缩后的 data URL;落成对象文件后,JSONB 里只留 key。
  const imageKeys = await saveAskPreviews(ownerId, imagePreviews ?? []);
  const detail = {
    ...rest,
    imageCount: imageKeys.length || rest.imageCount,
  };
  const serialized = JSON.stringify(detail);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DETAIL_BYTES) {
    throw new Error("这条历史的详情过大,未保存");
  }

  let replacedKeys: string[] = [];
  let trimmedKeys: string[] = [];
  await transaction(async (client) => {
    const previous = await client.query<{ image_keys: string[] }>(
      "SELECT image_keys FROM ask_history WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    replacedKeys = previous.rows[0]?.image_keys ?? [];

    const written = await client.query(
      `INSERT INTO ask_history (id, owner_id, starfield_id, question, answer, image_keys, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
       ON CONFLICT (id) DO UPDATE SET
         question = excluded.question,
         answer = excluded.answer,
         image_keys = excluded.image_keys,
         created_at = excluded.created_at
       WHERE ask_history.owner_id = excluded.owner_id`,
      [id, ownerId, starfieldId, question, answer, imageKeys, createdAt],
    );
    // id 撞上别的账号时上面的 WHERE 会让更新落空,不能继续写详情
    if (!written.rowCount) throw new Error("历史记录 id 冲突");

    await client.query(
      `INSERT INTO ask_history_details (history_id, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (history_id) DO UPDATE SET payload = excluded.payload`,
      [id, serialized],
    );

    const removed = await client.query<{ image_keys: string[] }>(
      `DELETE FROM ask_history
       WHERE owner_id = $1 AND starfield_id = $2 AND id NOT IN (
         SELECT id FROM ask_history
         WHERE owner_id = $1 AND starfield_id = $2
         ORDER BY created_at DESC LIMIT $3
       )
       RETURNING image_keys`,
      [ownerId, starfieldId, MAX_PER_STARFIELD],
    );
    trimmedKeys = removed.rows.flatMap((row) => row.image_keys ?? []);
  });

  const kept = new Set(imageKeys);
  const removable = [...replacedKeys, ...trimmedKeys].filter((key) => !kept.has(key));
  if (removable.length) await deleteUnreferencedMedia(ownerId, removable).catch(() => 0);
}

/**
 * 列表:只返回渲染历史面板需要的字段。
 * 回答截到 280 字,完整内容走 getAskHistoryEntry。
 */
export async function listAskHistory(
  ownerId: string,
  starfieldId: string,
  limit = 30,
): Promise<AskHistorySummary[]> {
  const rows = await query<SummaryRow>(
    `SELECT id, question, left(answer, ${SUMMARY_ANSWER_CHARS}) AS answer, created_at,
            cardinality(image_keys) AS image_count
     FROM ask_history WHERE owner_id = $1 AND starfield_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [ownerId, starfieldId, limit],
  );
  return rows.map(toSummary);
}

export async function getAskHistoryEntry(
  ownerId: string,
  starfieldId: string,
  id: string,
): Promise<AskHistoryEntry | null> {
  const row = await queryOne<DetailRow>(
    `SELECT h.id, h.question, h.answer, h.created_at, h.image_keys, d.payload
     FROM ask_history h
     JOIN ask_history_details d ON d.history_id = h.id
     WHERE h.owner_id = $1 AND h.starfield_id = $2 AND h.id = $3`,
    [ownerId, starfieldId, id],
  );
  return row ? toEntry(row) : null;
}

async function deleteRows(
  ownerId: string,
  starfieldId: string,
  id?: string,
): Promise<{ removed: number; imageKeys: string[] }> {
  const rows = id
    ? await query<{ image_keys: string[] }>(
        "DELETE FROM ask_history WHERE owner_id = $1 AND starfield_id = $2 AND id = $3 RETURNING image_keys",
        [ownerId, starfieldId, id],
      )
    : await query<{ image_keys: string[] }>(
        "DELETE FROM ask_history WHERE owner_id = $1 AND starfield_id = $2 RETURNING image_keys",
        [ownerId, starfieldId],
      );
  return {
    removed: rows.length,
    imageKeys: rows.flatMap((row) => row.image_keys ?? []),
  };
}

export async function deleteAskHistory(
  ownerId: string,
  starfieldId: string,
  id?: string,
): Promise<number> {
  const result = await deleteRows(ownerId, starfieldId, id);
  if (result.imageKeys.length) {
    await deleteUnreferencedMedia(ownerId, result.imageKeys).catch(() => 0);
  }
  return result.removed;
}

/** 删除星空时一并清掉它的历史(表之间没有物理外键,避免测试/导入数据被卡住)。 */
export async function deleteAskHistoryForStarfield(
  ownerId: string,
  starfieldId: string,
): Promise<number> {
  return deleteAskHistory(ownerId, starfieldId);
}

/** 后台清理用:当前仍被历史引用的图片 key。 */
export async function listAskHistoryImageKeys(): Promise<string[]> {
  const rows = await query<{ key: string }>(
    "SELECT DISTINCT unnest(image_keys) AS key FROM ask_history",
  );
  return rows.map((row) => row.key);
}
