import type { RelationPreset } from "@/types/kg";

import { edgeKindLabel } from "./edge-labels";

/**
 * 内置关系的边类型。
 *
 * 内置 id 与边类型历史上不是同一个字符串(基线 → BASELINE_OF),
 * 这张表保留那层映射;自定义关系统一走 `CUSTOM_<ID>` 命名空间,
 * 避免与 CITES / PART_OF 等保留类型撞名。
 */
export const BUILTIN_EDGE_KIND = {
  baseline: "BASELINE_OF",
  contemporary: "CONTEMPORARY_OF",
  similar: "SIMILAR_APPROACH",
  alternative: "ALTERNATIVE_TO",
  extends: "EXTENDS",
  contradicts: "CONTRADICTS",
} as const;

export type BuiltinPresetId = keyof typeof BUILTIN_EDGE_KIND;

export function edgeKindOf(presetId: string): string {
  const builtin = BUILTIN_EDGE_KIND[presetId as BuiltinPresetId];
  if (builtin) return builtin;
  return `CUSTOM_${presetId.toUpperCase().replace(/-/g, "_")}`;
}

export function presetOfEdgeKind(
  kind: string,
  presets: readonly RelationPreset[] | undefined,
): RelationPreset | undefined {
  return presets?.find((preset) => edgeKindOf(preset.id) === kind);
}

export function edgeLabelForKind(
  kind: string,
  presets: readonly RelationPreset[] | undefined,
): string {
  return presetOfEdgeKind(kind, presets)?.label ?? edgeKindLabel(kind);
}
