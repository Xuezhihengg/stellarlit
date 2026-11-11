/**
 * 账号体系校验 —— PostgreSQL 版。
 *
 * 只测「身份与边界」,不测 UI:
 *   - 口令用 scrypt 存,同一密码两次哈希不同(随机盐),错误密码验不过;
 *   - 邮箱大小写不敏感且唯一;
 *   - 第一个账号接管 legacy 数据,第二个账号从空开始;
 *   - 会话可读、可销毁、过期即失效,库里只有哈希;
 *   - 跨账号读同一片星空返回 null(不存在,而不是别人的数据);
 *   - 模型服务配置按账号隔离,切换账号就是切换整套 API Key。
 *
 * 运行:`pnpm check:auth`(已被 `pnpm check` 调用),使用独立测试库。
 */

import { createHash } from "node:crypto";

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
  process.env.DATABASE_URL = TEST_URL;
  process.env.STELLARLIT_SKIP_LEGACY_IMPORT = "1";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");

  const { queryOne, closePool } = await import("../src/server/db");
  const { hashPassword, verifyPassword } = await import("../src/server/auth/password");
  const {
    registerUser,
    loginUser,
    findUserByEmail,
    EmailTakenError,
    updateUserName,
    updateUserPassword,
    verifyUserPassword,
  } = await import("../src/server/auth/users");
  const mcpTokens = await import("../src/server/db/mcp-tokens");
  const { createSession, readSession, destroySession, pruneExpiredSessions } = await import(
    "../src/server/auth/session"
  );
  const starfields = await import("../src/server/db/starfields");
  const modelSettings = await import("../src/server/db/model-settings");

  // ---------------------------------------------------------------------
  // 1. 口令哈希
  // ---------------------------------------------------------------------
  const hashA = await hashPassword("correct horse battery");
  const hashB = await hashPassword("correct horse battery");
  expect("哈希格式是 scrypt", hashA.startsWith("scrypt$16384$8$1$"), hashA.slice(0, 20));
  expect("同一密码两次哈希不同", hashA !== hashB);
  expect("正确密码可验证", await verifyPassword("correct horse battery", hashA));
  expect("错误密码不通过", !(await verifyPassword("Correct horse battery", hashA)));
  expect("损坏哈希不通过", !(await verifyPassword("x", "not-a-hash")));

  // ---------------------------------------------------------------------
  // 2. 注册 / 唯一性 / 首个账号接管
  // ---------------------------------------------------------------------
  const legacyPayload = {
    starfield: {
      id: "sf-legacy",
      name: "旧数据",
      ownerId: "local",
      seeds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewport: { x: 0, y: 0, scale: 1 },
      stats: { papers: 0, edges: 0, communities: 0, domains: 0 },
    },
    graph: { nodes: [], edges: [] },
    layout: { nodes: {} },
    presets: [],
    meta: {},
  } as never;
  await starfields.saveStarfieldRow(legacyPayload, "legacy");

  const first = await registerUser({ email: "First@Example.com", password: "first-pass-123", name: "第一" });
  expect("邮箱被规范化", first.user.email === "first@example.com");
  expect("首个账号接管旧星空", first.claimed.starfields === 1, JSON.stringify(first.claimed));
  expect("接管后按新账号可读", (await starfields.loadStarfieldRow("sf-legacy", first.user.id)) !== null);

  const stored = await queryOne<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [first.user.id],
  );
  expect(
    "库里不是明文密码",
    Boolean(stored) && stored!.password_hash !== "first-pass-123" && stored!.password_hash.startsWith("scrypt$"),
  );

  let duplicate = false;
  try {
    await registerUser({ email: "first@example.com", password: "another-pass-123" });
  } catch (error) {
    duplicate = error instanceof EmailTakenError;
  }
  expect("邮箱唯一且大小写不敏感", duplicate);

  const second = await registerUser({ email: "second@example.com", password: "second-pass-123" });
  expect("第二个账号不接管数据", second.claimed.starfields === 0, JSON.stringify(second.claimed));
  expect("第二个账号看不到别人的星空", (await starfields.loadStarfieldRow("sf-legacy", second.user.id)) === null);
  expect("第二个账号列表为空", (await starfields.listStarfieldSummaries(second.user.id)).length === 0);
  expect("第一个账号仍能看到", (await starfields.listStarfieldSummaries(first.user.id)).length === 1);

  // ---------------------------------------------------------------------
  // 3. 模型配置按账号隔离
  // ---------------------------------------------------------------------
  const settingsFor = (key: string) => ({
    version: 1 as const,
    accounts: [
      { id: `acc-${key}`, provider: "deepseek" as const, name: key, baseUrl: "https://api.deepseek.com/v1", apiKey: `sk-${key}` },
    ],
    models: [
      { id: `m-${key}`, accountId: `acc-${key}`, name: key, model: "deepseek-chat", modalities: ["text" as const] },
    ],
    services: { relation: `m-${key}`, ask: null, translate: null },
    embedding: { accountId: null, model: "" },
  });
  await modelSettings.writeStoredSettings(first.user.id, settingsFor("first"));
  await modelSettings.writeStoredSettings(second.user.id, settingsFor("second"));
  const firstSettings = await modelSettings.readStoredSettings(first.user.id);
  const secondSettings = await modelSettings.readStoredSettings(second.user.id);
  expect(
    "账号 A 只看到自己的 API Key",
    firstSettings.accounts[0]?.apiKey === "sk-first" && firstSettings.services.relation === "m-first",
  );
  expect(
    "账号 B 只看到自己的 API Key",
    secondSettings.accounts[0]?.apiKey === "sk-second" && secondSettings.services.relation === "m-second",
  );
  const storedKey = await queryOne<{ api_key: string }>(
    "SELECT api_key FROM model_accounts WHERE owner_id = $1",
    [first.user.id],
  );
  expect(
    "API Key 在库里是密文",
    Boolean(storedKey) && storedKey!.api_key.startsWith("enc:v1:") && !storedKey!.api_key.includes("sk-first"),
  );

  // ---------------------------------------------------------------------
  // 4. 登录
  // ---------------------------------------------------------------------
  expect("正确密码可登录", (await loginUser("FIRST@example.com", "first-pass-123"))?.id === first.user.id);
  expect("错误密码登录失败", (await loginUser("first@example.com", "nope")) === null);
  expect("不存在账号登录失败", (await loginUser("ghost@example.com", "whatever")) === null);
  expect("按邮箱能找到用户", (await findUserByEmail("first@example.com"))?.id === first.user.id);

  // ---------------------------------------------------------------------
  // 5. 资料与改密
  // ---------------------------------------------------------------------
  expect("昵称可更新", (await updateUserName(first.user.id, "改名后"))?.name === "改名后");
  expect("正确密码可通过改密校验", await verifyUserPassword(first.user.id, "first-pass-123"));
  expect("错误密码不能通过改密校验", !(await verifyUserPassword(first.user.id, "wrong-pass")));

  await updateUserPassword(first.user.id, "new-pass-456");
  expect("旧密码失效", (await loginUser("first@example.com", "first-pass-123")) === null);
  expect("新密码可登录", (await loginUser("first@example.com", "new-pass-456"))?.id === first.user.id);

  // ---------------------------------------------------------------------
  // 6. 会话
  // ---------------------------------------------------------------------
  const session = await createSession(first.user.id, "check-auth");
  const read = await readSession(session.token);
  expect("会话可读", read?.id === first.user.id, read?.email);
  const plaintext = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM sessions WHERE token_hash = $1",
    [session.token],
  );
  expect("会话不保存明文令牌", Number(plaintext?.n ?? 0) === 0);

  await destroySession(session.token);
  expect("销毁后失效", (await readSession(session.token)) === null);

  const expired = "expired-token-for-test";
  await modelSettings.writeStoredSettings("session-test", settingsFor("session"));
  const holder = await registerUser({ email: "session@example.com", password: "session-pass-123" });
  await queryOne(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [createHash("sha256").update(expired).digest("hex"), holder.user.id, Date.now() - 1000],
  );
  expect("过期会话失效", (await readSession(expired)) === null);
  await pruneExpiredSessions();
  const left = await queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM sessions");
  expect("过期会话被清掉", Number(left?.n ?? 0) === 0);

  // ---------------------------------------------------------------------
  // 7. MCP 个人令牌:只解析到自己的账号,撤销后立即失效
  // ---------------------------------------------------------------------
  const created = await mcpTokens.createMcpToken(first.user.id, "Claude Code");
  const resolved = await mcpTokens.resolveMcpToken(created.token);
  expect("令牌解析到所属账号", resolved?.ownerId === first.user.id, JSON.stringify(resolved));
  expect("伪造令牌无效", (await mcpTokens.resolveMcpToken("slmcp_not-a-real-token")) === null);
  const listed = await mcpTokens.listMcpTokens(first.user.id);
  expect(
    "令牌记录最近使用时间",
    listed.length === 1 && listed[0]!.id === created.summary.id && Boolean(listed[0]!.lastUsedAt),
  );
  expect("别的账号看不到令牌", (await mcpTokens.listMcpTokens(holder.user.id)).length === 0);
  expect("不能替别的账号撤销", !(await mcpTokens.revokeMcpToken(holder.user.id, created.summary.id)));
  expect("本人可以撤销", await mcpTokens.revokeMcpToken(first.user.id, created.summary.id));
  expect("撤销后令牌失效", (await mcpTokens.resolveMcpToken(created.token)) === null);

  await closePool();

  if (problems.length > 0) {
    console.error("账号体系校验失败:\n" + problems.map((problem) => `  x ${problem}`).join("\n"));
    process.exit(1);
  }

  console.log(
    `账号体系一致(口令哈希 / 注册唯一 / 旧数据接管 / 模型配置隔离 / 登录 / 会话 / 归属 共 ${checks} 项)`,
  );
}

main().catch((error: unknown) => {
  console.error("账号体系校验崩溃:", error);
  process.exit(1);
});
