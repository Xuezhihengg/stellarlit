/**
 * 星空仓储(PostgreSQL)。
 *
 * payload 用 JSONB 整份存:图谱是派生产物,拆成节点表和边表只会让读取多几次
 * join,换不来看得见的收益;但列表页需要的名称、种子、规模单独落列,
 * 「列出所有星空」不再反序列化每一份 payload。
 *
 * 每条查询都带 owner_id —— 跨账号读同一个 id 得到的是「不存在」。
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { StarfieldPayload } from "@/types/api";
import type { StarfieldSummary } from "@/types/starfield";

import { serverConfig } from "../config";
import { execute, query, queryOne, readMeta, writeMeta } from ".";

const LEGACY_OWNER = "legacy";

interface SummaryRow {
  id: string;
  name: string;
  seed_titles: string[];
  stats: StarfieldSummary["stats"];
  updated_at: Date;
}

function seedTitlesOf(payload: StarfieldPayload): string[] {
  const paperById = new Map(
    payload.graph.nodes.filter((node) => node.kind === "paper").map((node) => [node.id, node]),
  );
  return payload.starfield.seeds
    .map((seed) => {
      const node = paperById.get(seed.paperId);
      return node && node.kind === "paper" ? node.title : seed.query;
    })
    .slice(0, 4);
}

async function upsertRow(payload: StarfieldPayload, ownerId: string): Promise<void> {
  const starfield = payload.starfield;
  const serialized = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  if (payloadBytes > serverConfig.cache.starfieldMaxBytes) {
    throw new Error(
      `星空数据超过 ${Math.round(serverConfig.cache.starfieldMaxBytes / 1024 / 1024)}MB 上限`,
    );
  }
  await query(
    `INSERT INTO starfields
       (id, owner_id, name, payload, seed_titles, stats, seed_count, paper_count, edge_count, payload_bytes, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       payload = excluded.payload,
       seed_titles = excluded.seed_titles,
       stats = excluded.stats,
       seed_count = excluded.seed_count,
       paper_count = excluded.paper_count,
       edge_count = excluded.edge_count,
       payload_bytes = excluded.payload_bytes,
       updated_at = excluded.updated_at
     WHERE starfields.owner_id = excluded.owner_id`,
    [
      starfield.id,
      ownerId,
      starfield.name,
      serialized,
      JSON.stringify(seedTitlesOf(payload)),
      JSON.stringify(starfield.stats),
      starfield.seeds.length,
      payload.graph.nodes.filter((node) => node.kind === "paper").length,
      payload.graph.edges.length,
      payloadBytes,
      new Date(starfield.createdAt),
      new Date(starfield.updatedAt),
    ],
  );
}

/**
 * 全新部署的演示数据:把仓库里自带的 `data/starfields/*.json` 导入为 legacy 归属。
 * 只执行一次,用 app_meta 记账;之后再跑也不会重复插入。
 */
async function ensureBootstrapImported(): Promise<void> {
  if (process.env.STELLARLIT_SKIP_LEGACY_IMPORT === "1") return;
  if (await readMeta("legacy:starfields:v1")) return;
  const dir = path.join(serverConfig.dataDir, "starfields");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // 全新安装没有旧目录
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const payload = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as StarfieldPayload;
      if (payload?.starfield?.id) await upsertRow(payload, LEGACY_OWNER);
    } catch {
      // 单个损坏文件不影响其它存档
    }
  }
  await writeMeta("legacy:starfields:v1", new Date().toISOString());
}

/** 首次注册接管 legacy 前调用:把仓库自带的演示星空先导进来。 */
export async function ensureLegacyStarfieldsImported(): Promise<void> {
  await ensureBootstrapImported();
}

export async function saveStarfieldRow(payload: StarfieldPayload, ownerId: string): Promise<void> {
  await upsertRow(payload, ownerId);
}

export async function loadStarfieldRow(id: string, ownerId: string): Promise<StarfieldPayload | null> {
  await ensureBootstrapImported();
  const row = await queryOne<{ payload: StarfieldPayload }>(
    "SELECT payload FROM starfields WHERE id = $1 AND owner_id = $2",
    [id, ownerId],
  );
  return row?.payload ?? null;
}

export async function listStarfieldSummaries(
  ownerId: string,
  limit = 200,
): Promise<StarfieldSummary[]> {
  await ensureBootstrapImported();
  const rows = await query<SummaryRow>(
    `SELECT id, name, seed_titles, stats, updated_at
     FROM starfields WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2`,
    [ownerId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    seedTitles: row.seed_titles,
    updatedAt: row.updated_at.toISOString(),
    stats: row.stats,
  }));
}

export async function deleteStarfieldRow(id: string, ownerId: string): Promise<void> {
  await ensureBootstrapImported();
  await execute("DELETE FROM starfields WHERE id = $1 AND owner_id = $2", [id, ownerId]);
}

export async function countStarfields(ownerId: string): Promise<number> {
  await ensureBootstrapImported();
  const row = await queryOne<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM starfields WHERE owner_id = $1",
    [ownerId],
  );
  return Number(row?.n ?? 0);
}
