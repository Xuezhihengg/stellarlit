/**
 * 关系预设一致性校验。
 *
 * 关系判定同时被三处消费:设置页的分组与编辑器、管道里的硬约束、
 * 证据链里的 promptVersion。少一个 family、把版本号写成别的格式,
 * 类型都不会报错,只会在界面上少一组、或让缓存永远命中旧的结论。
 *
 * 运行:`pnpm check:relations`(已被 `pnpm check` 调用)
 */

import { BUILTIN_PRESETS, PRESET_TO_EDGE_KIND, edgeKindOf } from "../src/server/relations/presets";
import { RelationPresetSchema } from "../src/server/relations/schema";
import {
  customPresetId,
  makeCustomPreset,
  validateCustomPreset,
} from "../src/lib/presets/custom";
import { mergePresets } from "../src/lib/presets/merge";
import {
  multiLabelSystem,
  multiLabelTaxonomy,
  normalizeMultiLabels,
} from "../src/server/relations/pipeline";
import type { RelationFamily, RelationPreset } from "../src/types/kg";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) return;
  problems.push(detail ? `${name} —— ${detail}` : name);
}

const FAMILIES: RelationFamily[] = ["lineage", "comparison", "conflict", "custom"];
const ids = new Set(BUILTIN_PRESETS.map((preset) => preset.id));

// 1. 身份与分组
expect("至少保留六类关系", BUILTIN_PRESETS.length >= 6, String(BUILTIN_PRESETS.length));
expect("关系 id 不重复", ids.size === BUILTIN_PRESETS.length);
expect(
  "关系显示名不重复",
  new Set(BUILTIN_PRESETS.map((preset) => preset.label)).size === BUILTIN_PRESETS.length,
);

for (const family of ["lineage", "comparison", "conflict"] as const) {
  expect(`关系族 ${family} 至少有一条`, BUILTIN_PRESETS.some((preset) => preset.family === family));
}

for (const preset of BUILTIN_PRESETS) {
  // 2. 设置页依赖 family 分组;旧覆盖允许缺失,但内置预设不能缺
  expect(`${preset.id} 有合法关系族`, FAMILIES.includes(preset.family ?? "custom"), String(preset.family));
  expect(`${preset.id} 通过请求校验`, RelationPresetSchema.safeParse(preset).success);

  // 3. 版本号既是证据链的一部分,也是判定缓存的键的一部分
  const version = /^([a-z][a-z0-9-]*)@(\d+)$/.exec(preset.promptVersion);
  expect(`${preset.id} 版本号格式为 id@n`, Boolean(version), preset.promptVersion);
  expect(`${preset.id} 版本号前缀与 id 一致`, version?.[1] === preset.id, preset.promptVersion);

  // 4. 产出上限与视觉编码
  expect(`${preset.id} 产出上限在 1–40`, preset.maxPerSeed >= 1 && preset.maxPerSeed <= 40);
  expect(
    `${preset.id} 视觉色使用语义令牌`,
    preset.visual.tone.startsWith("var(--"),
    preset.visual.tone,
  );
  expect(
    `${preset.id} 虚线样式合法`,
    !preset.visual.dash || preset.visual.dash === "none" || /^\d+ \d+$/.test(preset.visual.dash),
    String(preset.visual.dash),
  );

  // 5. 硬约束之间不能自相矛盾,也不能留下管道没实现的开关
  const c = preset.hardConstraints;
  expect(`${preset.id} 引用条件不互斥`, !(c.requireCitation && c.requireMutualNonCitation));
  expect(
    `${preset.id} 没有未实现的共享方法约束`,
    !c.requireSharedMethod,
    "管道尚未实现 requireSharedMethod",
  );
  expect(
    `${preset.id} 年份差上限合法`,
    c.maxYearGap === undefined || c.maxYearGap === null || (c.maxYearGap >= 0 && c.maxYearGap <= 60),
    String(c.maxYearGap),
  );
  expect(
    `${preset.id} 相似度阈值合法`,
    c.minSimilarity === undefined ||
      c.minSimilarity === null ||
      (c.minSimilarity >= 0 && c.minSimilarity <= 1),
    String(c.minSimilarity),
  );
}

// 6. 六类关系的领域约定:方向、引用与窗口必须和描述一致
const byId = new Map(BUILTIN_PRESETS.map((preset) => [preset.id, preset]));
const baseline = byId.get("baseline");
const contemporary = byId.get("contemporary");
const extendsPreset = byId.get("extends");
const contradicts = byId.get("contradicts");

expect("基线是有向关系", baseline?.directed === true);
expect("基线必须存在引用", baseline?.hardConstraints.requireCitation === true);
expect("扩展是有向关系", extendsPreset?.directed === true);
expect("扩展必须存在引用", extendsPreset?.hardConstraints.requireCitation === true);
expect("同期必须互不引用", contemporary?.hardConstraints.requireMutualNonCitation === true);
expect("同期年份差不超过 2", contemporary?.hardConstraints.maxYearGap === 2);
expect("矛盾必须共享主题", contradicts?.hardConstraints.requireSharedTask === true);

// 7. 每条关系都要能落到一个唯一的边类型
for (const preset of BUILTIN_PRESETS) {
  expect(`${preset.id} 有边类型映射`, preset.id in PRESET_TO_EDGE_KIND);
  expect(`${preset.id} 边类型非空`, Boolean(edgeKindOf(preset.id)));
}
expect(
  "边类型不重复",
  new Set(BUILTIN_PRESETS.map((preset) => edgeKindOf(preset.id))).size === BUILTIN_PRESETS.length,
);

// 8. 多标签判定:一对论文一次调用,但输出必须仍然可控
const similar = byId.get("similar");
const eligibleTwo = [baseline, extendsPreset].filter(
  (preset): preset is RelationPreset => Boolean(preset),
);

const normalized = normalizeMultiLabels(
  [
    { relationId: "baseline", confidence: 0.61, rationale: "低置信度的一次", evidence: null },
    { relationId: "baseline", confidence: 0.93, rationale: "更高置信度的同一条" },
    { relationId: "extends", confidence: 0.73 },
    { relationId: "not-a-relation", confidence: 1 },
    { relationId: "contemporary", confidence: 1 },
  ],
  eligibleTwo,
);

expect("多标签过滤未知关系 id", normalized.every((label) => label.relationId !== "not-a-relation"));
expect(
  "多标签过滤这一对不可判的关系",
  normalized.every((label) => label.relationId !== "contemporary"),
);
expect("重复标签只保留一条", normalized.filter((label) => label.relationId === "baseline").length === 1);
expect(
  "重复标签保留最高置信度",
  normalized.find((label) => label.relationId === "baseline")?.confidence === 0.93,
);
expect("多标签保留多条成立关系", normalized.length === 2);
expect("多标签按置信度降序", normalized[0]?.relationId === "baseline");
expect("多标签把 evidence=null 归一为空数组", normalized.every((label) => Array.isArray(label.evidence)));

const missingConfidence = normalizeMultiLabels(
  [{ relationId: "extends", confidence: Number.NaN, rationale: "  " }],
  eligibleTwo,
);
expect("缺省置信度回落到 0.7", missingConfidence[0]?.confidence === 0.7);
expect("空 rationale 有可展示的兜底", Boolean(missingConfidence[0]?.rationale.trim()));
expect("没有标签时返回空数组", normalizeMultiLabels([], eligibleTwo).length === 0);
expect(
  "全部越界时返回空数组",
  normalizeMultiLabels([{ relationId: "unknown", confidence: 1 }], eligibleTwo).length === 0,
);

const taxonomy = multiLabelTaxonomy(
  [baseline, similar].filter((preset): preset is RelationPreset => Boolean(preset)),
);
expect("关系清单包含关系 id", taxonomy.includes("baseline") && taxonomy.includes("similar"));
expect("关系清单写明方向", taxonomy.includes("有向") && taxonomy.includes("无向"));
expect("关系清单写明证据策略", taxonomy.includes("structural") && taxonomy.includes("textual"));
expect("关系清单带反例边界", taxonomy.includes("反例"));
expect("系统提示词要求返回所有成立关系", multiLabelSystem().includes("所有成立的关系"));
expect("系统提示词要求 labels 为空数组", multiLabelSystem().includes("labels 为空数组"));
expect("系统提示词与批处理 schema 同为 results 结构", multiLabelSystem().includes('{"results"'));

// 9. 自定义关系:id 稳定、边类型不撞内置命名空间、合并时不丢
const customInput = {
  label: "因果",
  labelEn: "Causal Link",
  description: "一方是另一方结论成立的原因。",
  definition: "A 的结果被 B 作为解释前提,且 B 明确引用 A 的证据链。",
  negativeExamples: "只是同一数据集上的两个结果,不算因果。",
  family: "custom" as const,
  directed: true,
  evidencePolicy: "textual" as const,
};

expect("自定义 id 从英文名生成", customPresetId("Causal Link", []) === "causal-link");
expect(
  "自定义 id 冲突时自动加后缀",
  customPresetId("Causal Link", ["causal-link"]) === "causal-link-2",
);
expect(
  "自定义 id 不以数字开头",
  /^[a-z]/.test(customPresetId("3D scene graph", [])),
);

const custom = makeCustomPreset(customInput, BUILTIN_PRESETS);
expect("自定义关系通过请求校验", RelationPresetSchema.safeParse(custom).success);
expect("自定义关系标记为非内置", custom.builtin === false);
expect("自定义关系版本从 v1 开始", custom.promptVersion === `${custom.id}@1`);
expect("自定义边类型避开内置命名空间", edgeKindOf(custom.id) === "CUSTOM_CAUSAL_LINK");
expect("自定义关系默认启用", custom.enabled === true);
expect(
  "自定义关系名称重复会被拦截",
  validateCustomPreset({ ...customInput, label: "基线" }, BUILTIN_PRESETS) !== null,
);
expect("合法自定义关系通过校验", validateCustomPreset(customInput, BUILTIN_PRESETS) === null);

const mergedCustom = mergePresets(BUILTIN_PRESETS, [custom]);
expect("合并覆盖时保留全部内置关系", mergedCustom.length === BUILTIN_PRESETS.length + 1);
expect("合并后自定义关系仍在", mergedCustom.some((preset) => preset.id === custom.id));
expect("合并后内置关系不被覆盖成自定义", mergedCustom[0]?.builtin === true);

if (problems.length) {
  console.error("关系预设不一致:\n" + problems.map((item) => `  · ${item}`).join("\n"));
  process.exit(1);
}

console.log(`关系预设一致(分组 / 约束 / 版本 / 视觉 / 边类型 / 多标签 共 ${checks} 项)`);
