/**
 * 关系预设合并。
 *
 * 服务端是唯一副本:内置预设 + 当前账号的覆盖。合并而不是替换,
 * 这样将来新增内置关系时,老账号的覆盖不会把新项吞掉;
 * 覆盖里不属于内置集合的条目是用户自建的关系,必须追加保留。
 */

import type { RelationPreset } from "@/types/kg";

/**
 * 把账号保存的覆盖合并到内置预设上。
 *
 * 合并而不是替换:内置预设将来新增字段或新增预设项时,
 * 账号里已有的覆盖不该把它吞掉;覆盖里不属于内置集合的条目,
 * 则是用户自己新建的关系,必须追加保留。
 */
export function mergePresets(
  builtin: RelationPreset[],
  overrides: RelationPreset[] | null,
): RelationPreset[] {
  if (!overrides?.length) return builtin;
  const byId = new Map(overrides.map((p) => [p.id, p]));
  const builtinIds = new Set(builtin.map((preset) => preset.id));
  const merged = builtin.map((base) => {
    const over = byId.get(base.id);
    return over ? { ...base, ...over, builtin: base.builtin } : base;
  });
  // 覆盖里不属于内置集合的条目,就是用户新建的关系:追加而不是丢掉
  const custom = overrides
    .filter((preset) => !builtinIds.has(preset.id))
    .map((preset) => ({ ...preset, builtin: false }));
  return [...merged, ...custom];
}
