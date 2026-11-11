/**
 * 服务商配置一致性校验。
 *
 * 新增一家服务商要同时改三处:types 里的 id 清单、catalog 里的预设、
 * public/icons/providers/<id>.svg。少一个图标文件不会报错,
 * 只会让已保存记录左边空出一块 —— 是那种"类型全绿但界面缺一块"的故障。
 *
 * 运行:`pnpm check:providers`(已被 `pnpm check` 调用)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PROVIDER_PRESETS } from "../src/lib/models/catalog";
import { MODEL_PROVIDER_IDS } from "../src/types/model-settings";

const ROOT = path.resolve(__dirname, "..");
const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) return;
  problems.push(detail ? `${name} —— ${detail}` : name);
}

// 1. id 清单与预设目录必须一一对应,顺序一致(卡片按这个顺序排)
expect(
  "预设数量与 id 清单一致",
  PROVIDER_PRESETS.length === MODEL_PROVIDER_IDS.length,
  `预设 ${PROVIDER_PRESETS.length} / 清单 ${MODEL_PROVIDER_IDS.length}`,
);
expect(
  "id 顺序与清单一致",
  PROVIDER_PRESETS.every((p, i) => p.id === MODEL_PROVIDER_IDS[i]),
  PROVIDER_PRESETS.map((p) => p.id).join(","),
);
expect(
  "id 不重复",
  new Set(PROVIDER_PRESETS.map((p) => p.id)).size === PROVIDER_PRESETS.length,
);
// providerPreset 认不出来的 id 会兜底到"最后一项",它必须是可手动填写的兼容接口
expect("兜底预设是自定义接口", PROVIDER_PRESETS.at(-1)?.id === "custom");

// 2. 每家都有可用的官方品牌图标
for (const id of MODEL_PROVIDER_IDS) {
  const file = path.join(ROOT, "public/icons/providers", `${id}.svg`);
  if (!existsSync(file)) {
    expect(`${id} 有品牌图标`, false, "缺少 public/icons/providers/" + id + ".svg");
    continue;
  }
  const svg = readFileSync(file, "utf8");
  expect(
    `${id} 图标可用作遮罩`,
    svg.includes("<path") && svg.includes("viewBox") && !svg.includes("currentColor"),
    svg.slice(0, 80),
  );
}

// 3. 接入地址与模型清单
for (const preset of PROVIDER_PRESETS) {
  if (preset.id === "custom") {
    expect("自定义接口留给用户填写", preset.baseUrl === "" && preset.models.length === 0);
    continue;
  }
  expect(
    `${preset.id} 地址是 OpenAI 兼容端`,
    /^https:\/\/[^\s]+\/v\d+\/?$/.test(preset.baseUrl),
    preset.baseUrl,
  );
  expect(`${preset.id} 至少有一个预置模型`, preset.models.length > 0);
  expect(
    `${preset.id} 模型 id 不重复`,
    new Set(preset.models.map((m) => m.model)).size === preset.models.length,
  );
  for (const model of preset.models) {
    expect(`${preset.id}/${model.model} 有模态`, model.modalities.length > 0);
    expect(`${preset.id}/${model.model} 有显示名`, model.name.trim().length > 0);
  }
}

if (problems.length > 0) {
  console.error("服务商配置校验失败:\n" + problems.map((p) => `  x ${p}`).join("\n"));
  process.exit(1);
}

console.log(
  `服务商配置一致(清单 / 图标 / 地址 / 模型 共 ${checks} 项 · ${PROVIDER_PRESETS.length} 家)`,
);
