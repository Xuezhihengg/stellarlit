/**
 * 持久化层校验 —— PostgreSQL 版。
 *
 * 不测业务逻辑,只测「数据真的进得去、读得回来、删得干净、账号之间不串」:
 *   - 迁移可重复执行,不会重复建表;
 *   - 星空按 upsert 写,列表字段来自列而不是解析整个 payload;
 *   - 模型服务按 owner 隔离,三张表的外键级联,删账户会带走模型;
 *   - 问答历史按星空裁剪到 50 条,删除单条/全部都能生效;
 *   - 关系预设整组替换,不同账号互不可见;
 *   - 事务异常整体回滚。
 *
 * 运行:`pnpm check:db`(已被 `pnpm check` 调用)。用独立测试库,不碰开发库。
 */

import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "pg";

const TEST_URL = process.env.TEST_DATABASE_URL || "postgresql://localhost:5432/stellarlit_test";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

async function resetTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  await resetTestDatabase();
  const tempData = await mkdtemp(path.join(tmpdir(), "stellarlit-db-check-"));
  process.env.DATABASE_URL = TEST_URL;
  process.env.STELLARLIT_DATA_DIR = tempData;
  process.env.STELLARLIT_SKIP_LEGACY_IMPORT = "1";
  // 固定测试密钥:只用于自检库,不是任何真实环境的主密钥
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SAFETY_DAILY_TOKEN_BUDGET = "200";

  const { query, queryOne, closePool, transaction, execute } = await import("../src/server/db");
  const starfields = await import("../src/server/db/starfields");
  const settings = await import("../src/server/db/model-settings");
  const history = await import("../src/server/db/ask-history");
  const presets = await import("../src/server/db/presets");
  const { encryptSecret } = await import("../src/server/security/secrets");
  const usage = await import("../src/server/db/usage");
  const imageIndex = await import("../src/server/rag/image-index");
  const media = await import("../src/server/media/store");
  const { checkBudget, usageSnapshot } = await import("../src/server/safety/limits");

  // ---------------------------------------------------------------------
  // 1. 迁移
  // ---------------------------------------------------------------------
  const migrations = await query<{ version: number; name: string }>(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  );
  expect("迁移已记录", migrations.length >= 1 && migrations[0]!.version === 1, JSON.stringify(migrations));
  const tables = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  expect("建表完成", Number(tables?.n ?? 0) >= 11, String(tables?.n));

  // ---------------------------------------------------------------------
  // 2. 星空:写入 / 覆盖 / 列表 / 账号隔离 / 删除
  // ---------------------------------------------------------------------
  const now = new Date().toISOString();
  const payload = {
    starfield: {
      id: "sf-db-test",
      name: "数据库测试",
      ownerId: "local",
      seeds: [{ query: "seed query", paperId: "p1", addedAt: now, addedPapers: 1 }],
      createdAt: now,
      updatedAt: now,
      viewport: { x: 0, y: 0, scale: 1 },
      stats: { papers: 2, edges: 1, communities: 1, domains: 1 },
    },
    graph: {
      nodes: [
        { id: "p1", kind: "paper", title: "Paper One" },
        { id: "p2", kind: "paper", title: "Paper Two" },
      ],
      edges: [{ id: "e1", source: "p1", target: "p2", kind: "BASELINE_OF" }],
    },
    layout: { nodes: {} },
    presets: [],
    meta: {},
  } as never;

  const OWNER = "user-test";
  await starfields.saveStarfieldRow(payload, OWNER);
  const loaded = await starfields.loadStarfieldRow("sf-db-test", OWNER);
  expect("星空可读回", loaded?.starfield.name === "数据库测试");
  expect("payload 完整", isDeepStrictEqual(loaded, payload));
  expect(
    "别的账号读不到",
    (await starfields.loadStarfieldRow("sf-db-test", "user-other")) === null,
  );

  const listed = await starfields.listStarfieldSummaries(OWNER);
  expect("列表只取摘要", listed.length === 1 && listed[0]!.seedTitles[0] === "Paper One");
  expect("规模列正确", listed[0]!.stats.papers === 2 && listed[0]!.stats.edges === 1);
  expect("别的账号列表为空", (await starfields.listStarfieldSummaries("user-other")).length === 0);

  await starfields.saveStarfieldRow(
    {
      ...(payload as Record<string, unknown>),
      starfield: { ...(payload as { starfield: object }).starfield, name: "改名后" },
    } as never,
    OWNER,
  );
  const afterUpdate = await starfields.listStarfieldSummaries(OWNER);
  expect("upsert 不产生重复行", afterUpdate.length === 1, String(afterUpdate.length));
  expect("upsert 更新名称", afterUpdate[0]!.name === "改名后");

  // ---------------------------------------------------------------------
  // 3. 模型服务:写入 / 读回 / owner 隔离 / 级联删除
  // ---------------------------------------------------------------------
  const ACC_A = "user-a";
  const ACC_B = "user-b";
  await settings.writeStoredSettings(ACC_A, {
    version: 1,
    accounts: [
      { id: "acc-1", provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-test" },
      { id: "acc-2", provider: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-two" },
    ],
    models: [
      { id: "m-1", accountId: "acc-1", name: "chat", model: "deepseek-chat", modalities: ["text"] },
      { id: "m-2", accountId: "acc-2", name: "vision", model: "gpt-4o", modalities: ["text", "vision"] },
    ],
    services: { relation: "m-1", ask: "m-2", translate: "m-1" },
    embedding: { accountId: "acc-1", model: "text-embedding-3-small" },
  });
  await settings.writeStoredSettings(ACC_B, {
    version: 1,
    accounts: [
      { id: "acc-b", provider: "deepseek", name: "B 的账户", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-b" },
    ],
    models: [
      { id: "m-b", accountId: "acc-b", name: "chat", model: "deepseek-chat", modalities: ["text"] },
    ],
    services: { relation: "m-b", ask: null, translate: null },
    embedding: { accountId: null, model: "" },
  });

  const rawKey = await queryOne<{ api_key: string }>(
    "SELECT api_key FROM model_accounts WHERE owner_id = $1 AND id = $2",
    [ACC_A, "acc-1"],
  );
  expect("API Key 以密文落库", Boolean(rawKey) && rawKey!.api_key.startsWith("enc:v1:"), rawKey?.api_key.slice(0, 12));
  expect("库里不含明文密钥", !rawKey!.api_key.includes("sk-test"));

  const readA = await settings.readStoredSettings(ACC_A);
  expect("账户读回", readA.accounts.length === 2);
  expect("密钥解密回原文", readA.accounts[0]!.apiKey === "sk-test", readA.accounts[0]!.apiKey);
  expect("模型读回", readA.models[1]!.modalities.includes("vision"));
  expect("服务绑定读回", readA.services.ask === "m-2");
  expect("向量绑定读回", readA.embedding?.model === "text-embedding-3-small");

  const readB = await settings.readStoredSettings(ACC_B);
  expect("B 只看到自己的账户", readB.accounts.length === 1 && readB.accounts[0]!.id === "acc-b");
  expect("B 的服务绑定是独立的", readB.services.relation === "m-b" && readB.services.ask === null);
  expect("B 看不到 A 的向量配置", readB.embedding?.model === "");

  // 旧明文迁移:直接插入一条没有 enc:v1 前缀的历史行,读之前应被自动加密
  const PLAIN_OWNER = "user-plain";
  await execute(
    `INSERT INTO model_accounts (id, owner_id, provider, name, base_url, api_key, position)
     VALUES ($1, $2, 'deepseek', '旧明文', 'https://api.deepseek.com/v1', 'sk-legacy-plain', 0)`,
    ["acc-plain", PLAIN_OWNER],
  );
  const migrated = await settings.migratePlaintextSecrets();
  expect("旧明文被加密迁移", migrated >= 1, String(migrated));
  const migratedRaw = await queryOne<{ api_key: string }>(
    "SELECT api_key FROM model_accounts WHERE owner_id = $1",
    [PLAIN_OWNER],
  );
  expect("迁移后落库是密文", migratedRaw!.api_key.startsWith("enc:v1:"));
  expect(
    "迁移后仍能解出原文",
    (await settings.readStoredSettings(PLAIN_OWNER)).accounts[0]!.apiKey === "sk-legacy-plain",
  );

  // 密文被篡改:账户视为不可用,而不是拿乱码去请求上游
  const TAMPER_OWNER = "user-tamper";
  const sealed = encryptSecret("sk-tamper");
  const broken = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
  await execute(
    `INSERT INTO model_accounts (id, owner_id, provider, name, base_url, api_key, position)
     VALUES ($1, $2, 'deepseek', '篡改', 'https://api.deepseek.com/v1', $3, 0)`,
    ["acc-tamper", TAMPER_OWNER, broken],
  );
  expect(
    "篡改的密钥不可用",
    (await settings.readStoredSettings(TAMPER_OWNER)).accounts[0]!.apiKey === "",
  );

  await execute("DELETE FROM model_accounts WHERE owner_id = $1 AND id = $2", [ACC_A, "acc-1"]);
  const afterCascade = await settings.readStoredSettings(ACC_A);
  expect("删账户级联删模型", afterCascade.models.length === 1, String(afterCascade.models.length));
  expect("级联只删对应账户", afterCascade.models[0]!.accountId === "acc-2");
  expect("B 的模型未受影响", (await settings.readStoredSettings(ACC_B)).models.length === 1);

  // ---------------------------------------------------------------------
  // 4. 问答历史:裁剪 / 排序 / 删除 / 账号隔离
  // ---------------------------------------------------------------------
  const base = Date.now();
  for (let i = 0; i < 55; i++) {
    await history.saveAskHistoryEntry(OWNER, "sf-db-test", {
      id: `h-${i}`,
      createdAt: base + i,
      question: `问题 ${i}`,
      answer: "回答",
      sources: [],
      citations: [],
      suggestions: [],
      fallback: false,
    });
  }
  const rowCount = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM ask_history WHERE owner_id = $1 AND starfield_id = $2",
    [OWNER, "sf-db-test"],
  );
  expect("每片星空只留 50 条", Number(rowCount?.n ?? 0) === 50, String(rowCount?.n));

  const recent = await history.listAskHistory(OWNER, "sf-db-test", 3);
  expect("按时间倒序", recent[0]!.id === "h-54" && recent[2]!.id === "h-52", recent.map((r) => r.id).join(","));
  expect("历史内容完整", recent[0]!.question === "问题 54");
  expect("别的账号看不到历史", (await history.listAskHistory("user-other", "sf-db-test")).length === 0);

  await history.deleteAskHistory(OWNER, "sf-db-test", "h-54");
  expect("删除单条", (await history.listAskHistory(OWNER, "sf-db-test", 1))[0]!.id === "h-53");

  // 图片预览不落 JSONB:详情表只存文本,图片进入 media 对象目录
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await history.saveAskHistoryEntry(OWNER, "sf-db-test", {
    id: "h-image",
    createdAt: base + 100,
    question: "这张图说明了什么?",
    answer: "图中的曲线在 40 附近达到峰值。",
    sources: [],
    citations: [],
    suggestions: [],
    fallback: false,
    imagePreviews: [png],
  });
  const withImage = await history.getAskHistoryEntry(OWNER, "sf-db-test", "h-image");
  expect("详情能读回图片路径", withImage?.imagePreviews?.[0]?.startsWith("/api/media/ask/") === true);
  expect("详情带图片数量", withImage?.imageCount === 1, String(withImage?.imageCount));
  const imageRow = await queryOne<{ image_keys: string[]; detail_bytes: number; detail_text: string }>(
    `SELECT h.image_keys, pg_column_size(d.payload) AS detail_bytes, d.payload::text AS detail_text
     FROM ask_history h JOIN ask_history_details d ON d.history_id = h.id WHERE h.id = $1`,
    ["h-image"],
  );
  expect("图片 key 写入独立列", imageRow?.image_keys.length === 1, JSON.stringify(imageRow?.image_keys));
  expect("详情 JSONB 不含 base64", !(imageRow?.detail_text ?? "").includes("data:image"));
  expect("详情 JSONB 保持轻量", Number(imageRow?.detail_bytes ?? 0) < 4_000, String(imageRow?.detail_bytes));
  const stored = await media.readMedia(OWNER, imageRow?.image_keys[0] ?? "");
  expect("媒体对象可读且按账号隔离", stored?.mime === "image/png" && stored.data.byteLength > 0);
  expect("别的账号读不到媒体", (await media.readMedia("user-other", imageRow?.image_keys[0] ?? "")) === null);
  expect(
    "列表不返回详情",
    !("sources" in ((await history.listAskHistory(OWNER, "sf-db-test", 1))[0] ?? {})),
  );
  expect("列表回答已截断", (await history.listAskHistory(OWNER, "sf-db-test", 1))[0]!.answer.length <= 281);

  // 同一张图被两条历史引用时,删一条不能把共享对象删掉
  await history.saveAskHistoryEntry(OWNER, "sf-db-test", {
    id: "h-image-2",
    createdAt: base + 101,
    question: "再问一次同一张图",
    answer: "同一个对象可以复用。",
    sources: [],
    citations: [],
    suggestions: [],
    fallback: false,
    imagePreviews: [png],
  });
  await history.deleteAskHistory(OWNER, "sf-db-test", "h-image");
  expect(
    "共享图片不被误删",
    (await media.readMedia(OWNER, imageRow?.image_keys[0] ?? "")) !== null,
  );
  await history.deleteAskHistory(OWNER, "sf-db-test", "h-image-2");
  expect(
    "最后一条引用删除后清对象",
    (await media.readMedia(OWNER, imageRow?.image_keys[0] ?? "")) === null,
  );

  await history.deleteAskHistory(OWNER, "sf-db-test");
  expect("清空一片星空", (await history.listAskHistory(OWNER, "sf-db-test")).length === 0);

  // ---------------------------------------------------------------------
  // 5. 关系预设
  // ---------------------------------------------------------------------
  const preset = {
    id: "custom-test",
    label: "测试关系",
    labelEn: "Test",
    family: "custom",
    description: "测试用",
    definition: "定义",
    negativeExamples: "反例",
    directed: false,
    hardConstraints: {},
    evidencePolicy: "textual",
    visual: { tone: "accent" },
    promptVersion: "custom-test@1",
    enabled: true,
    maxPerSeed: 5,
    builtin: false,
  } as never;
  await presets.writePresetOverrides(OWNER, [preset]);
  const readPresets = await presets.readPresetOverrides(OWNER);
  expect("预设读回", readPresets?.length === 1 && readPresets[0]!.id === "custom-test");
  expect("别的账号看不到", (await presets.readPresetOverrides("user-other")) === null);
  await presets.clearPresetOverrides(OWNER);
  expect("预设清空", (await presets.readPresetOverrides(OWNER)) === null);

  // ---------------------------------------------------------------------
  // 6. token 用量:按账号隔离 / 跨请求累加 / 预算阈值
  // ---------------------------------------------------------------------
  await usage.recordUsage("user-usage-a", 60, 1);
  await usage.recordUsage("user-usage-a", 40, 2);
  await usage.recordUsage("user-usage-b", 10, 1);

  const usageA = await usage.readUsage("user-usage-a");
  expect("用量按请求累加", usageA.tokens === 100 && usageA.calls === 3, JSON.stringify(usageA));
  expect("账号之间用量隔离", (await usage.readUsage("user-usage-b")).tokens === 10);

  const snapshotA = await usageSnapshot("user-usage-a");
  expect("预算快照带余额", snapshotA.budget === 200 && snapshotA.remaining === 100, JSON.stringify(snapshotA));
  expect("未超预算时放行", (await checkBudget("user-usage-a")).ok);

  await usage.recordUsage("user-usage-a", 150, 1);
  const blockedBudget = await checkBudget("user-usage-a");
  expect("超预算时拒绝", !blockedBudget.ok && blockedBudget.code === "budget_exhausted");
  expect("另一个账号仍有额度", (await checkBudget("user-usage-b")).ok);

  const week = await usage.listUsage("user-usage-a", 7);
  expect("最近 7 天补齐缺口", week.length === 7 && week[6]!.tokens === 250, JSON.stringify(week));

  // ---------------------------------------------------------------------
  // 6.5 图像分析缓存:过期与超量淘汰
  // ---------------------------------------------------------------------
  await query("DELETE FROM image_index_cache");
  const nowMs = Date.now();
  for (let i = 0; i < 4; i++) {
    await query(
      `INSERT INTO image_index_cache (hash, version, analysis, created_at, last_hit_at)
       VALUES ($1, 1, '{}'::jsonb, $2, $3)`,
      [`hash-${i}`, nowMs - 10 * 24 * 60 * 60 * 1000, nowMs - (i < 3 ? 10 : 0) * 24 * 60 * 60 * 1000],
    );
  }
  const imagePrune = await imageIndex.pruneImageIndexCache({
    maxRows: 2,
    maxAgeMs: 24 * 60 * 60 * 1000,
  });
  expect("图像缓存按空闲时间淘汰", imagePrune.deleted === 3, JSON.stringify(imagePrune));
  const imageLeft = await queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM image_index_cache");
  expect("图像缓存只留活跃行", Number(imageLeft?.n ?? 0) === 1, String(imageLeft?.n));

  // ---------------------------------------------------------------------
  // 7. 事务回滚
  // ---------------------------------------------------------------------
  let rolledBack = false;
  try {
    await transaction(async (tx) => {
      await tx.query("INSERT INTO app_meta (key, value) VALUES ($1, $2)", ["tx-key", "1"]);
      throw new Error("boom");
    });
  } catch {
    rolledBack = true;
  }
  const txRow = await queryOne("SELECT value FROM app_meta WHERE key = 'tx-key'");
  expect("异常时整体回滚", rolledBack && txRow === null);

  // ---------------------------------------------------------------------
  // 8. 删除星空
  // ---------------------------------------------------------------------
  await starfields.deleteStarfieldRow("sf-db-test", OWNER);
  expect("删除星空", (await starfields.loadStarfieldRow("sf-db-test", OWNER)) === null);
  expect("计数归零", (await starfields.countStarfields(OWNER)) === 0);

  await rm(tempData, { recursive: true, force: true });
  await closePool();

  if (problems.length > 0) {
    console.error("持久化校验失败:\n" + problems.map((problem) => `  x ${problem}`).join("\n"));
    process.exit(1);
  }

  console.log(
    `持久化一致(迁移 / 星空 / 模型服务按账号隔离 / 历史裁剪 / 预设 / 事务 共 ${checks} 项)`,
  );
}

main().catch((error: unknown) => {
  console.error("持久化校验崩溃:", error);
  process.exit(1);
});
