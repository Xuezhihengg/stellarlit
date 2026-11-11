/**
 * Redis 缓存与清理校验。
 *
 * 覆盖:连接、TTL、删除、跨请求节流、磁盘缓存按时间/容量淘汰。
 * 这是一项外部依赖检查 —— Redis 没启动时会明确报错,而不是静默跳过。
 */

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Redis from "ioredis";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "stellarlit-cache-check-"));
  const prefix = `stellarlit-check-${Date.now()}`;
  process.env.STELLARLIT_DATA_DIR = tempDir;
  process.env.REDIS_PREFIX = prefix;

  const { cacheDel, cacheGet, cacheSet, closeRedis, redisHealth, redisKey, waitForHostSlot } =
    await import("../src/server/redis");
  const { pruneDiskCache } = await import("../src/server/cache");
  const raw = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  raw.on("error", () => undefined);

  try {
    const health = await redisHealth();
    expect("Redis 可连接", health.ok, health.error);

    const key = redisKey("check", "ttl");
    expect("写入缓存", await cacheSet(key, { value: 42 }, 30));
    expect("读回缓存", (await cacheGet<{ value: number }>(key))?.value === 42);
    const ttl = await raw.ttl(key);
    expect("缓存带 TTL", ttl > 0 && ttl <= 30, String(ttl));
    await cacheDel(key);
    expect("删除后不再命中", (await cacheGet(key)) === null);

    const started = Date.now();
    await waitForHostSlot("cache-check.local", 350);
    await waitForHostSlot("cache-check.local", 350);
    const elapsed = Date.now() - started;
    expect("跨请求节流生效", elapsed >= 300, `${elapsed}ms`);

    const namespaceDir = path.join(tempDir, "cache", "check");
    await mkdir(namespaceDir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const file = path.join(namespaceDir, `v1-${i}.json`);
      await writeFile(file, "{}", "utf8");
      const old = new Date(now - (i + 2) * 24 * 60 * 60 * 1000);
      await utimes(file, old, old);
    }
    await writeFile(path.join(namespaceDir, "fresh.json"), "{}", "utf8");
    const pruned = await pruneDiskCache({ maxBytes: 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1000 });
    expect("过期磁盘缓存被删", pruned.deleted === 3, JSON.stringify(pruned));
    expect("未过期文件保留", pruned.remainingBytes === 2, JSON.stringify(pruned));

    const keys = await raw.keys(`${prefix}:*`);
    if (keys.length) await raw.del(...keys);
  } finally {
    await raw.quit().catch(() => raw.disconnect());
    await closeRedis();
    await rm(tempDir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error("缓存校验失败:\n" + problems.map((item) => `  x ${item}`).join("\n"));
    process.exit(1);
  }
  console.log(`Redis 缓存一致(连接 / TTL / 删除 / 节流 / 磁盘淘汰 共 ${checks} 项)`);
}

main().catch((error: unknown) => {
  console.error("缓存校验崩溃:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
