/** 手动执行一次清理:会话、图像分析缓存、磁盘缓存。 */

import { closePool } from "../src/server/db";
import { runMaintenance } from "../src/server/maintenance";
import { closeRedis } from "../src/server/redis";

async function main(): Promise<void> {
  const result = await runMaintenance();
  console.log(JSON.stringify(result, null, 2));
  await closeRedis();
  await closePool();
  if (result.errors.length) process.exit(1);
}

main().catch((error: unknown) => {
  console.error("清理失败:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
