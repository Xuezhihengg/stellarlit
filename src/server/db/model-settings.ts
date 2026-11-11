/**
 * 模型服务仓储 —— 按账号隔离。
 *
 * 账户、模型清单、服务绑定、向量绑定四张表都带 owner_id:
 * 切换账号就是切换整套模型配置,而不是全站共用一份 API Key。
 *
 * API Key 用 AES-256-GCM 加密后存库,主密钥来自 `ENCRYPTION_KEY`;
 * 数据库泄露或备份被读走时,拿到的只是密文。旧库里的明文会在首次读取后
 * 自动加密回写,不需要手工迁移。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ModelModality,
  ModelProviderId,
  ModelServiceId,
} from "@/types/model-settings";

import { serverConfig } from "../config";
import { decryptSecret, encryptSecret, isEncryptedSecret, isEncryptionConfigured } from "../security/secrets";
import { execute, query, readMeta, transaction, writeMeta } from ".";

const LEGACY_OWNER = "legacy";

export interface StoredAccount {
  id: string;
  provider: ModelProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface StoredModel {
  id: string;
  accountId: string;
  name: string;
  model: string;
  modalities: ModelModality[];
}

export interface StoredSettings {
  version: 1;
  accounts: StoredAccount[];
  models: StoredModel[];
  services: Record<ModelServiceId, string | null>;
  embedding?: { accountId: string | null; model: string };
}

/**
 * 一次性把历史明文密钥加密回写。
 *
 * 只在本进程第一次读配置时跑;之后所有写入都会直接写密文。
 * 迁移失败不阻塞读取 —— 明文仍可用,但会在日志里明确提示。
 */
let plaintextMigration: Promise<number> | undefined;

export async function migratePlaintextSecrets(): Promise<number> {
  if (!isEncryptionConfigured()) return 0;
  const rows = await query<{ id: string; owner_id: string; api_key: string }>(
    "SELECT id, owner_id, api_key FROM model_accounts WHERE api_key <> ''",
  );
  let changed = 0;
  for (const row of rows) {
    if (isEncryptedSecret(row.api_key)) continue;
    const encrypted = encryptSecret(row.api_key);
    const updated = await execute(
      "UPDATE model_accounts SET api_key = $1 WHERE id = $2 AND owner_id = $3 AND api_key = $4",
      [encrypted, row.id, row.owner_id, row.api_key],
    );
    changed += updated;
  }
  return changed;
}

export function ensureSecretsEncrypted(): Promise<number> {
  plaintextMigration ??= migratePlaintextSecrets().catch((error) => {
    console.error(
      "[db] API Key 加密迁移失败:",
      error instanceof Error ? error.message : String(error),
    );
    return 0;
  });
  return plaintextMigration;
}

export async function readStoredSettings(ownerId: string): Promise<StoredSettings> {
  await ensureSecretsEncrypted();
  const [accounts, models, bindings, embedding] = await Promise.all([
    query<{ id: string; provider: string; name: string; base_url: string; api_key: string }>(
      `SELECT id, provider, name, base_url, api_key FROM model_accounts
       WHERE owner_id = $1 ORDER BY position, id`,
      [ownerId],
    ),
    query<{ id: string; account_id: string; name: string; model: string; modalities: ModelModality[] }>(
      `SELECT id, account_id, name, model, modalities FROM model_catalog
       WHERE owner_id = $1 ORDER BY position, id`,
      [ownerId],
    ),
    query<{ service: string; model_id: string | null }>(
      "SELECT service, model_id FROM service_bindings WHERE owner_id = $1",
      [ownerId],
    ),
    query<{ account_id: string | null; model: string }>(
      "SELECT account_id, model FROM embedding_binding WHERE owner_id = $1",
      [ownerId],
    ),
  ]);

  const services: Record<ModelServiceId, string | null> = {
    relation: null,
    ask: null,
    translate: null,
  };
  for (const row of bindings) {
    if (row.service in services) services[row.service as ModelServiceId] = row.model_id;
  }

  return {
    version: 1,
    accounts: accounts.map((row) => ({
      id: row.id,
      provider: row.provider as ModelProviderId,
      name: row.name,
      baseUrl: row.base_url,
      // 解不开的密钥按空处理:宁可显式「账户不可用」,也不拿乱码去请求上游
      apiKey: decryptSecret(row.api_key) ?? "",
    })),
    models: models.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      model: row.model,
      modalities: row.modalities,
    })),
    services,
    embedding: {
      accountId: embedding[0]?.account_id ?? null,
      model: embedding[0]?.model ?? "",
    },
  };
}

/** 把旧 JSON 配置导入给 legacy,首个账号注册时会连同星空一起接管。 */
export async function ensureLegacyModelSettings(): Promise<void> {
  if (process.env.STELLARLIT_SKIP_LEGACY_IMPORT === "1") return;
  if (await readMeta("legacy:model-settings:v1")) return;
  await writeMeta("legacy:model-settings:v1", new Date().toISOString());
  const file = path.join(serverConfig.dataDir, "model-settings.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredSettings;
    if (parsed?.accounts?.length || parsed?.models?.length) {
      await writeStoredSettings(LEGACY_OWNER, parsed);
    }
  } catch {
    // 没有旧配置:新用户第一次打开设置页即可
  }
}

export async function writeStoredSettings(ownerId: string, settings: StoredSettings): Promise<void> {
  await transaction(async (client) => {
    await client.query("DELETE FROM model_catalog WHERE owner_id = $1", [ownerId]);
    await client.query("DELETE FROM model_accounts WHERE owner_id = $1", [ownerId]);
    await client.query("DELETE FROM service_bindings WHERE owner_id = $1", [ownerId]);

    for (const [index, account] of settings.accounts.entries()) {
      await client.query(
        `INSERT INTO model_accounts (id, owner_id, provider, name, base_url, api_key, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          account.id,
          ownerId,
          account.provider,
          account.name,
          account.baseUrl,
          encryptSecret(account.apiKey),
          index,
        ],
      );
    }

    for (const [index, model] of settings.models.entries()) {
      await client.query(
        `INSERT INTO model_catalog (id, owner_id, account_id, name, model, modalities, position)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          model.id,
          ownerId,
          model.accountId,
          model.name,
          model.model,
          JSON.stringify(model.modalities),
          index,
        ],
      );
    }

    const now = new Date();
    for (const [service, modelId] of Object.entries(settings.services)) {
      await client.query(
        `INSERT INTO service_bindings (owner_id, service, model_id, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [ownerId, service, modelId, now],
      );
    }

    await client.query(
      `INSERT INTO embedding_binding (owner_id, account_id, model, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) DO UPDATE SET
         account_id = excluded.account_id,
         model = excluded.model,
         updated_at = excluded.updated_at`,
      [ownerId, settings.embedding?.accountId ?? null, settings.embedding?.model ?? "", now],
    );
  });
}
