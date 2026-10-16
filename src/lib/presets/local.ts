"use client";

import type { RelationPreset } from "@/types/kg";

const KEY = "stellarlit:presets";

/**
 * 关系预设的本地覆盖。
 *
 * 为什么先放浏览器而不是服务端:预设是**用户的工作方式**,不是共享数据 ——
 * 一个人改判定标准不该影响别人。放在本地还能让演示时随手改一条看效果。
 * 服务端接口已经接受 presets 覆盖,将来要云同步时只需要把这层换掉。
 */
export function loadPresetOverrides(): RelationPreset[] | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RelationPreset[]) : null;
  } catch {
    // 旧版本存的结构不兼容时当作没有覆盖,而不是让设置页崩掉
    return null;
  }
}

export function savePresetOverrides(presets: RelationPreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    /* 隐私模式下写不进去,当前会话内仍然生效 */
  }
}

export function clearPresetOverrides(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}

/**
 * 把本地覆盖合并到内置预设上。
 *
 * 合并而不是替换:内置预设将来新增字段或新增预设项时,
 * 老用户的本地覆盖不该把它吞掉 —— 那会让升级后的新功能莫名其妙地不生效。
 */
export function mergePresets(
  builtin: RelationPreset[],
  overrides: RelationPreset[] | null,
): RelationPreset[] {
  if (!overrides?.length) return builtin;
  const byId = new Map(overrides.map((p) => [p.id, p]));
  return builtin.map((base) => {
    const over = byId.get(base.id);
    return over ? { ...base, ...over, builtin: base.builtin } : base;
  });
}
