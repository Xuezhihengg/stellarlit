import type { RelationFamily, RelationPreset } from "@/types/kg";

/** 与构建接口的 presets 上限保持一致。 */
export const MAX_RELATION_PRESETS = 24;

export interface CustomPresetInput {
  label: string;
  labelEn: string;
  description: string;
  definition: string;
  negativeExamples: string;
  family: RelationFamily;
  directed: boolean;
  evidencePolicy: RelationPreset["evidencePolicy"];
}

function slugOf(labelEn: string): string {
  const slug = labelEn
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!slug) return "relation";
  return /^[a-z]/.test(slug) ? slug : `rel-${slug}`;
}

export function customPresetId(labelEn: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = slugOf(labelEn);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base.slice(0, 36)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 32)}-${Date.now().toString(36)}`;
}

export function validateCustomPreset(
  input: CustomPresetInput,
  presets: readonly RelationPreset[],
): string | null {
  if (presets.length >= MAX_RELATION_PRESETS) return `最多只能有 ${MAX_RELATION_PRESETS} 条关系`;
  if (!input.label.trim()) return "请填写中文名称";
  if (!input.labelEn.trim()) return "请填写英文名称";
  if (!input.description.trim()) return "请写一句这条关系的定义";
  if (!input.definition.trim()) return "请填写判定标准";
  if (!input.negativeExamples.trim()) return "请填写反例";

  const label = input.label.trim().toLowerCase();
  if (presets.some((preset) => preset.label.toLowerCase() === label)) return "中文名称已存在";
  const labelEn = input.labelEn.trim().toLowerCase();
  if (presets.some((preset) => preset.labelEn.toLowerCase() === labelEn)) return "英文名称已存在";
  return null;
}

export function makeCustomPreset(
  input: CustomPresetInput,
  presets: readonly RelationPreset[],
): RelationPreset {
  const id = customPresetId(input.labelEn, presets.map((preset) => preset.id));
  return {
    id,
    label: input.label.trim().slice(0, 24),
    labelEn: input.labelEn.trim().slice(0, 48),
    family: input.family,
    description: input.description.trim().slice(0, 400),
    definition: input.definition.trim().slice(0, 2000),
    negativeExamples: input.negativeExamples.trim().slice(0, 2000),
    directed: input.directed,
    hardConstraints: { maxYearGap: 10 },
    evidencePolicy: input.evidencePolicy,
    visual: {
      tone: input.evidencePolicy === "textual" ? "var(--accent)" : "var(--ink-2)",
      dash: "none",
    },
    promptVersion: `${id}@1`,
    enabled: true,
    maxPerSeed: 4,
    builtin: false,
  };
}
