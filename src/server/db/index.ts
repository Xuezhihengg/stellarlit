/**
 * 持久化核心 —— PostgreSQL 连接池 + 版本化迁移。
 *
 * 为什么从 SQLite 换过来:多账号之后,写入不再是一个浏览器窗口的串行操作,
 * 而是「几个人同时改不同的星空」。SQLite 的单写者模型在单机上够用,但它没有
 * 真正的并发控制、也没有跨进程的锁;Postgres 的行锁、事务隔离与 JSONB 索引
 * 才是这个阶段该有的底座。
 *
 * 约定:
 *   - 连接串来自 DATABASE_URL,默认本机 stellarlit 库;
 *   - 迁移带 advisory lock:多个实例同时启动也只有一个在跑 DDL;
 *   - 时间列统一 timestamptz,毫秒时间戳(会话过期、历史排序)用 bigint;
 *   - payload / stats / preset / analysis 用 JSONB —— 读写仍是整份对象,
 *     但将来要按图里的字段查询时不用改表。
 */

import { Pool, type PoolClient, type QueryResultRow } from "pg";

const DEFAULT_URL = "postgresql://localhost:5432/stellarlit";

export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_URL;
}

interface DbGlobal {
  __stellarlitPool?: Pool;
  __stellarlitReady?: Promise<void>;
  __stellarlitMaintenanceScheduled?: boolean;
}

const globalForDb = globalThis as typeof globalThis & DbGlobal;

export function pool(): Pool {
  if (!globalForDb.__stellarlitPool) {
    const instance = new Pool({
      connectionString: databaseUrl(),
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // 单条语句超过 15 秒多半是查询写错了,不该一直占着连接
      statement_timeout: 15_000,
    });
    instance.on("error", (error) => {
      // 空闲连接被服务端掐断是正常现象,不能让它把进程带崩
      console.error("[db] idle client error", error.message);
    });
    globalForDb.__stellarlitPool = instance;
  }
  return globalForDb.__stellarlitPool;
}

const MIGRATION_LOCK = 726_314_001;

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "baseline",
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at BIGINT NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

      CREATE TABLE starfields (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        payload JSONB NOT NULL,
        seed_titles JSONB NOT NULL,
        stats JSONB NOT NULL,
        seed_count INTEGER NOT NULL DEFAULT 0,
        paper_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX starfields_owner_idx ON starfields (owner_id, updated_at DESC);

      CREATE TABLE model_accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX model_accounts_owner_idx ON model_accounts (owner_id, position);

      CREATE TABLE model_catalog (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES model_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        modalities JSONB NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX model_catalog_owner_idx ON model_catalog (owner_id, position);

      CREATE TABLE service_bindings (
        owner_id TEXT NOT NULL,
        service TEXT NOT NULL,
        model_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, service)
      );

      CREATE TABLE embedding_binding (
        owner_id TEXT PRIMARY KEY,
        account_id TEXT,
        model TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE ask_history (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        starfield_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX ask_history_owner_idx ON ask_history (owner_id, starfield_id, created_at DESC);

      CREATE TABLE image_index_cache (
        hash TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        analysis JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        last_hit_at BIGINT NOT NULL
      );

      CREATE TABLE relation_presets (
        owner_id TEXT NOT NULL,
        id TEXT NOT NULL,
        preset JSONB NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, id)
      );

      CREATE TABLE app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "usage-daily",
    sql: `
      CREATE TABLE usage_daily (
        owner_id TEXT NOT NULL,
        day TEXT NOT NULL,
        tokens BIGINT NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, day)
      );
      CREATE INDEX usage_daily_day_idx ON usage_daily (day);
    `,
  },
  {
    version: 3,
    name: "mcp-tokens",
    sql: `
      CREATE TABLE mcp_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ
      );
      CREATE INDEX mcp_tokens_owner_idx ON mcp_tokens (owner_id, created_at DESC);
    `,
  },
  {
    version: 4,
    name: "split-history-details-and-media",
    sql: `
      -- 问答历史的热字段留在主表,详情(来源 / 轨迹 / 判定)拆到附属表。
      -- 列表查询只读主表,不再把每条回答的完整 JSONB 拖出来。
      ALTER TABLE ask_history ADD COLUMN image_keys TEXT[] NOT NULL DEFAULT '{}';

      CREATE TABLE ask_history_details (
        history_id TEXT PRIMARY KEY REFERENCES ask_history(id) ON DELETE CASCADE,
        payload JSONB NOT NULL
      );

      -- 旧记录的图片预览是 base64,迁移时直接丢弃(原图本来就没入库);
      -- 新记录只保存 /api/media/... 路径,不再让大对象进 JSONB。
      INSERT INTO ask_history_details (history_id, payload)
      SELECT id, payload - 'imagePreviews' FROM ask_history;

      ALTER TABLE ask_history DROP COLUMN payload;

      -- 星图体积单独记账,便于发现异常膨胀;列表仍然不读 payload。
      ALTER TABLE starfields ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0;
      UPDATE starfields SET payload_bytes = pg_column_size(payload);
    `,
  },
  {
    version: 5,
    name: "starfield-preview",
    sql: `
      -- 历史卡片只需要几十个点,不该为此重新反序列化整份 payload。
      -- 旧记录先留空,列表接口首次读取时按需回填。
      ALTER TABLE starfields ADD COLUMN preview JSONB NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    version: 6,
    name: "drop-generated-starfield-preview",
    sql: `
      -- 预览改为卡片内用真实 payload 现场渲染,不再保存简化点线快照。
      ALTER TABLE starfields DROP COLUMN IF EXISTS preview;
    `,
  },
  {
    version: 7,
    name: "source-credentials",
    sql: `
      -- 文献数据源凭据按账号隔离。OpenAlex 的邮箱直接取 users.email;
      -- 这里存需要用户自己申请的第三方密钥(目前是 Semantic Scholar)。
      CREATE TABLE source_credentials (
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, source)
      );
    `,
  },
];

async function runMigrations(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    // 多实例同时启动时,只有一个能拿锁;其余的等它做完再看到已执行的版本
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 首次查询前自动迁移;失败后清空缓存的 Promise,下一次请求会重试。 */
export function ready(): Promise<void> {
  globalForDb.__stellarlitReady ??= runMigrations().catch((error) => {
    globalForDb.__stellarlitReady = undefined;
    throw error;
  });
  scheduleMaintenance();
  return globalForDb.__stellarlitReady;
}

/**
 * 数据库首次就绪后启动后台清理:启动时跑一次,之后按间隔重复。
 *
 * 为什么放在这里而不是 instrumentation.ts:后者会同时被 Edge 运行时编译,
 * 把 pg / ioredis / node:fs 整条依赖链拖进 Edge bundle 导致构建失败。
 * 这里只在 Node 服务端真正连库后触发,脚本(tsx)导入本模块时不受影响。
 */
function scheduleMaintenance(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (globalForDb.__stellarlitMaintenanceScheduled) return;
  globalForDb.__stellarlitMaintenanceScheduled = true;

  const timer = setTimeout(() => {
    void import("../maintenance")
      .then((module) => module.startMaintenanceLoop())
      .catch((error: unknown) => {
        console.warn(
          "[maintenance] 启动失败:",
          error instanceof Error ? error.message : String(error),
        );
      });
  }, 1_500);
  timer.unref?.();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ready();
  const result = await pool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** 只关心影响行数的写操作(UPDATE / DELETE)。 */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  await ready();
  const result = await pool().query(text, params);
  return result.rowCount ?? 0;
}

/** 事务:回调里必须用传进来的 client,不能用全局 query,否则不在同一个事务里。 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ready();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function readMeta(key: string): Promise<string | null> {
  return queryOne<{ value: string }>("SELECT value FROM app_meta WHERE key = $1", [key]).then(
    (row) => row?.value ?? null,
  );
}

export async function writeMeta(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** 测试用:关闭连接池,下一次 pool() 会按新的 DATABASE_URL 重建。 */
export async function closePool(): Promise<void> {
  await globalForDb.__stellarlitPool?.end().catch(() => undefined);
  globalForDb.__stellarlitPool = undefined;
  globalForDb.__stellarlitReady = undefined;
}
