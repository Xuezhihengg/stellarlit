/**
 * 关系判定探针。
 *
 * 用途:当界面上一类关系**一条都出不来**时,「模型认为都不成立」和
 * 「管道根本没把候选送到模型」是两种完全不同的故障,而两者在界面上长得一样。
 * 这个脚本把真实的提示词打出来、把模型的原始回答打出来,一次运行就能定位。
 *
 * 运行:pnpm probe [预设id] [条数]
 *   例:pnpm probe baseline 3
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { closePool, queryOne } from "../src/server/db";
import { chatJson, llmAvailable } from "@/server/llm/client";
import {
  generatePairs,
  heuristicScore,
  judgeSystem,
  orientPair,
  pairPrompt,
  passesHardConstraints,
} from "@/server/relations/pipeline";
import { BUILTIN_PRESETS } from "@/server/relations/presets";
import type { OaWork } from "@/server/sources/openalex";

const presetId = process.argv[2] ?? "baseline";
const limit = Number(process.argv[3] ?? 2);

const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
if (!preset) {
  console.error(`没有这个预设:${presetId}`);
  console.error(`可选:${BUILTIN_PRESETS.map((p) => p.id).join(", ")}`);
  process.exit(1);
}

// 读一份已缓存的邻域,避免为了一次诊断重新联网
const dir = path.join(process.cwd(), "data", "cache", "neighborhood");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
if (!files.length) {
  console.error("没有缓存的邻域数据,请先在界面上构建一次星空。");
  process.exit(1);
}

const chosen = files[0];
if (!chosen) process.exit(1);
const papers = JSON.parse(readFileSync(path.join(dir, chosen), "utf8")) as OaWork[];
console.log(`邻域:${chosen}(共 ${papers.length} 篇)\n`);

const seedId = papers[0]?.id ?? "";
const pairs = generatePairs(papers);
const eligible = pairs.filter((f) => passesHardConstraints(f, preset));
const seedRelated = eligible.filter((f) => {
  const a = papers[f.i];
  const b = papers[f.j];
  return Boolean(a && b && (a.id === seedId || b.id === seedId));
});

const ownerId =
  process.env.STELLARLIT_OWNER_ID?.trim() ||
  (await queryOne<{ id: string }>(
    "SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1",
  ))?.id;
if (!ownerId) {
  console.error("没有可用账号:先注册一个账号,或设置 STELLARLIT_OWNER_ID。");
  process.exit(1);
}

const hasLlm = await llmAvailable(ownerId, "relation");
console.log(`预设 ${preset.id} · 硬约束候选 ${eligible.length} 条,其中涉及种子 ${seedRelated.length} 条`);
console.log(`大模型可用:${hasLlm}\n`);

const ranked = seedRelated
  .map((f) => ({ f, s: heuristicScore(f, preset) }))
  .sort((x, y) => y.s - x.s)
  .slice(0, limit);

for (const { f, s } of ranked) {
  let a = papers[f.i];
  let b = papers[f.j];
  if (!a || !b) continue;
  const oriented = orientPair(f, a, b);
  a = oriented.a;
  b = oriented.b;

  console.log("=".repeat(72));
  console.log(`启发式分 ${s.toFixed(3)} · 引用关系 ${f.citesIJ ? "i→j" : f.citesJI ? "j→i" : "无"} · 年份差 ${f.yearGap}`);
  console.log(`A ${a.id} ${a.year} ${a.title.slice(0, 60)}`);
  console.log(`B ${b.id} ${b.year} ${b.title.slice(0, 60)}`);

  if (!hasLlm) {
    console.log("(当前账号未绑定关系判定模型,只能看到候选;先在设置页绑定服务商)\n");
    continue;
  }

  const result = await chatJson(
    {
      ownerId,
      system: judgeSystem(preset.evidencePolicy),
      user: pairPrompt(f, a, b, preset),
      temperature: 0.05,
      maxTokens: 900,
    },
    z.object({ match: z.boolean() }).passthrough(),
  );
  console.log("\n模型原始回答:");
  console.log(result ? result.raw : "(调用失败或输出无法解析)");
  console.log();
}

await closePool();
