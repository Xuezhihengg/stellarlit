/**
 * 生成 32 字节主密钥(base64)。
 *
 * 用法:pnpm key:generate
 * 把输出写进 .env.local 的 ENCRYPTION_KEY=...,不要提交到仓库。
 */

import { randomBytes } from "node:crypto";

process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
