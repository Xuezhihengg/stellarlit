/**
 * 关系预设的服务端覆盖(按账号)。
 *
 * 预设是「用户的工作方式」:换台机器、换个账号,判定口径都应该跟着账号走。
 */

import { RelationPresetSchema } from "@/server/relations/schema";
import type { RelationPreset } from "@/types/kg";

import { execute, query, transaction } from ".";

export async function readPresetOverrides(ownerId: string): Promise<RelationPreset[] | null> {
  const rows = await query<{ preset: RelationPreset }>(
    "SELECT preset FROM relation_presets WHERE owner_id = $1 ORDER BY position, id",
    [ownerId],
  );
  if (!rows.length) return null;
  const presets: RelationPreset[] = [];
  for (const row of rows) {
    const parsed = RelationPresetSchema.safeParse(row.preset);
    if (parsed.success) presets.push(parsed.data);
  }
  return presets.length ? presets : null;
}

export async function writePresetOverrides(
  ownerId: string,
  presets: RelationPreset[],
): Promise<void> {
  await transaction(async (client) => {
    await client.query("DELETE FROM relation_presets WHERE owner_id = $1", [ownerId]);
    const now = new Date();
    for (const [index, preset] of presets.entries()) {
      await client.query(
        `INSERT INTO relation_presets (owner_id, id, preset, position, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [ownerId, preset.id, JSON.stringify(preset), index, now],
      );
    }
  });
}

export async function clearPresetOverrides(ownerId: string): Promise<void> {
  await execute("DELETE FROM relation_presets WHERE owner_id = $1", [ownerId]);
}
