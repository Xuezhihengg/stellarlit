/**
 * 账号仓储与注册 / 登录规则。
 *
 * 第一个注册的账号会接管升级前的本机数据(owner_id = 'legacy'):
 * 那些星空是用户在这个实例上攒下的,不该因为加了登录就消失。
 * 之后注册的账号从空开始。
 */

import { randomBytes } from "node:crypto";

import { query, queryOne, transaction } from "../db";
import { ensureLegacyModelSettings } from "../db/model-settings";
import { ensureLegacyStarfieldsImported } from "../db/starfields";
import { dummyVerify, hashPassword, verifyPassword } from "./password";
import type { SessionUser } from "./session";

export const LEGACY_OWNER = "legacy";

/** 注册时串行化「是否首个账号」的判断,避免两个请求同时接管 legacy 数据。 */
const REGISTER_LOCK = 726_314_002;

export interface ClaimedData {
  starfields: number;
  history: number;
  presets: number;
}

export class EmailTakenError extends Error {
  constructor() {
    super("这个邮箱已经注册过了");
    this.name = "EmailTakenError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function countUsers(): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM users");
  return Number(row?.n ?? 0);
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: Date;
}

function toUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at.toISOString() };
}

export async function findUserById(id: string): Promise<SessionUser | null> {
  const row = await queryOne<UserRow>(
    "SELECT id, email, name, created_at FROM users WHERE id = $1",
    [id],
  );
  return row ? toUser(row) : null;
}

export async function findUserByEmail(email: string): Promise<SessionUser | null> {
  const row = await queryOne<UserRow>(
    "SELECT id, email, name, created_at FROM users WHERE lower(email) = $1",
    [normalizeEmail(email)],
  );
  return row ? toUser(row) : null;
}

export async function registerUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: SessionUser; claimed: ClaimedData }> {
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || email.split("@")[0] || "研究者";
  const passwordHash = await hashPassword(input.password);
  const id = `user-${randomBytes(8).toString("hex")}`;

  // 首个账号接管前,先把仓库自带的演示星空与旧 JSON 模型配置导入 legacy。
  // 否则在「全新库 + 直接注册」的顺序下,旧数据还没进库就已经错过接管时机。
  await ensureLegacyStarfieldsImported().catch(() => undefined);
  await ensureLegacyModelSettings().catch(() => undefined);

  try {
    return await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [REGISTER_LOCK]);
      const count = await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM users");
      const first = Number(count.rows[0]?.n ?? 0) === 0;

      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO users (id, email, name, password_hash, last_login_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING created_at`,
        [id, email, name, passwordHash],
      );

      let claimed: ClaimedData = { starfields: 0, history: 0, presets: 0 };
      if (first) {
        const starfields = await client.query(
          "UPDATE starfields SET owner_id = $1 WHERE owner_id = $2",
          [id, LEGACY_OWNER],
        );
        const history = await client.query(
          "UPDATE ask_history SET owner_id = $1 WHERE owner_id = $2",
          [id, LEGACY_OWNER],
        );
        const presets = await client.query(
          "UPDATE relation_presets SET owner_id = $1 WHERE owner_id = $2",
          [id, LEGACY_OWNER],
        );
        // 模型服务也是账号资产:首个账号一并接管,否则旧配置会停在 legacy 下丢失
        await client.query("UPDATE model_accounts SET owner_id = $1 WHERE owner_id = $2", [id, LEGACY_OWNER]);
        await client.query("UPDATE model_catalog SET owner_id = $1 WHERE owner_id = $2", [id, LEGACY_OWNER]);
        await client.query("UPDATE service_bindings SET owner_id = $1 WHERE owner_id = $2", [id, LEGACY_OWNER]);
        await client.query(
          `UPDATE embedding_binding SET owner_id = $1 WHERE owner_id = $2
             AND NOT EXISTS (SELECT 1 FROM embedding_binding WHERE owner_id = $1)`,
          [id, LEGACY_OWNER],
        );
        claimed = {
          starfields: starfields.rowCount ?? 0,
          history: history.rowCount ?? 0,
          presets: presets.rowCount ?? 0,
        };
      }

      const createdAt = inserted.rows[0]!.created_at.toISOString();
      return { user: { id, email, name, createdAt }, claimed };
    });
  } catch (error) {
    // 并发注册同一邮箱时,唯一索引是最后一道闸
    if ((error as { code?: string }).code === "23505") throw new EmailTakenError();
    throw error;
  }
}

export async function updateUserName(userId: string, name: string): Promise<SessionUser | null> {
  const row = await queryOne<UserRow>(
    `UPDATE users SET name = $1 WHERE id = $2
     RETURNING id, email, name, created_at`,
    [name.trim(), userId],
  );
  return row ? toUser(row) : null;
}

/** 改密前先验当前口令;失败返回 false,不区分「用户不存在」与「口令错误」。 */
export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const row = await queryOne<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [userId],
  );
  if (!row) {
    await dummyVerify(password);
    return false;
  }
  return verifyPassword(password, row.password_hash);
}

export async function updateUserPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, userId]);
}

export async function loginUser(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const row = await queryOne<UserRow & { password_hash: string }>(
    "SELECT id, email, name, created_at, password_hash FROM users WHERE lower(email) = $1",
    [normalizeEmail(email)],
  );

  if (!row) {
    // 账号不存在也付同样的计算代价,避免通过响应时间枚举邮箱
    await dummyVerify(password);
    return null;
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return null;

  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
  return toUser(row);
}

