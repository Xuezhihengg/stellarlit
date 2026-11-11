/**
 * 把数据库里遗留的明文 API Key 加密回写。
 *
 * 用法:pnpm secrets:migrate
 * 可重复执行:已经是密文的行会跳过。
 */

import { closePool } from "../src/server/db";
import { migratePlaintextSecrets } from "../src/server/db/model-settings";

async function main(): Promise<void> {
  if (!process.env.ENCRYPTION_KEY?.trim()) {
    console.error("缺少 ENCRYPTION_KEY:先在 .env.local 里生成主密钥(pnpm key:generate)");
    process.exit(1);
  }
  const changed = await migratePlaintextSecrets();
  console.log(`已加密 ${changed} 条 API Key`);
  await closePool();
}

main().catch((error: unknown) => {
  console.error("迁移失败:", error instanceof Error ? error.message : error);
  process.exit(1);
});
