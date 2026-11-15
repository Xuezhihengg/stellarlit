/**
 * 文献数据源设置 —— 对外只暴露邮箱与密钥提示,不返回明文 Key。
 */

import type { SourceSettingsDto } from "@/types/source";

import { readSourceIdentity, writeSemanticScholarKey } from "./db/source-settings";
import type { SourceContext } from "./sources/context";

function toDto(email: string, key: string): SourceSettingsDto {
  return {
    openalexMailto: email,
    hasSemanticScholarKey: Boolean(key),
    semanticScholarKeyHint: key ? `••••${key.slice(-4)}` : undefined,
  };
}

export async function getSourceSettings(ownerId: string): Promise<SourceSettingsDto> {
  const identity = await readSourceIdentity(ownerId);
  return toDto(identity.email, identity.semanticScholarKey);
}

export async function resolveSourceContext(ownerId: string): Promise<SourceContext> {
  const identity = await readSourceIdentity(ownerId);
  return {
    mailto: identity.email,
    semanticScholarKey: identity.semanticScholarKey || undefined,
  };
}

export async function saveSemanticScholarKey(
  ownerId: string,
  apiKey: string,
): Promise<SourceSettingsDto> {
  await writeSemanticScholarKey(ownerId, apiKey);
  return getSourceSettings(ownerId);
}
