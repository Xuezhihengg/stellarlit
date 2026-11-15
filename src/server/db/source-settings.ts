/**
 * 文献数据源凭据仓储。
 *
 * 只存用户自己申请的密钥(目前是 Semantic Scholar);OpenAlex 的邮箱
 * 直接读 users.email,不在这里重复保存。密钥与模型 API Key 一样按
 * AES-256-GCM 加密落库,读取时解不开就当作未配置。
 */

import { decryptSecret, encryptSecret } from "../security/secrets";
import { execute, queryOne } from ".";

export const SEMANTIC_SCHOLAR = "semantic_scholar";

interface SourceRow {
  email: string;
  api_key: string | null;
}

async function readRow(ownerId: string): Promise<SourceRow | null> {
  return queryOne<SourceRow>(
    `SELECT u.email, sc.api_key
       FROM users u
       LEFT JOIN source_credentials sc
         ON sc.owner_id = u.id AND sc.source = $2
      WHERE u.id = $1`,
    [ownerId, SEMANTIC_SCHOLAR],
  );
}

export async function readSourceIdentity(
  ownerId: string,
): Promise<{ email: string; semanticScholarKey: string }> {
  const row = await readRow(ownerId);
  if (!row) return { email: "", semanticScholarKey: "" };
  return {
    email: row.email,
    semanticScholarKey: row.api_key ? (decryptSecret(row.api_key) ?? "") : "",
  };
}

export async function writeSemanticScholarKey(
  ownerId: string,
  apiKey: string,
): Promise<void> {
  const key = apiKey.trim();
  if (!key) {
    await execute(
      "DELETE FROM source_credentials WHERE owner_id = $1 AND source = $2",
      [ownerId, SEMANTIC_SCHOLAR],
    );
    return;
  }
  await execute(
    `INSERT INTO source_credentials (owner_id, source, api_key, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (owner_id, source)
     DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now()`,
    [ownerId, SEMANTIC_SCHOLAR, encryptSecret(key)],
  );
}
