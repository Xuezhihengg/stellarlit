/**
 * 敏感字段加密 —— AES-256-GCM,主密钥来自环境变量。
 *
 * 为什么不是哈希:API Key 需要原样拿去请求供应商,只能可逆加密。
 * 为什么用 GCM:它在加密之外还带认证标签,密文被篡改会解密失败,
 * 而不是悄悄解出一段错误的密钥去请求上游。
 *
 * 存储格式:`enc:v1:<iv>.<tag>.<ciphertext>`,三段都是 base64url。
 * 没有前缀的行按「升级前的明文」读取,首次读取后会被自动加密回写,
 * 因此旧库不需要手工迁移。
 *
 * 边界(如实写):
 *   - 主密钥和进程在同一台机器上,能读环境变量的人仍能解密;
 *     它防的是「拿到数据库备份 / SQL 注入读表」,不是防服务器被完全控制。
 *   - 生产环境强制要求 ENCRYPTION_KEY;开发环境未配置时保留明文并告警,
 *     避免本地演示因为少一个变量直接起不来。
 *   - 轮换密钥:把旧密钥放到 ENCRYPTION_KEY_PREVIOUS,新密钥放 ENCRYPTION_KEY,
 *     读取仍可用;之后重新保存一次配置即可全部换成新密钥。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD = Buffer.from("stellarlit:model-api-key:v1", "utf8");

let warnedMissingKey = false;
let warnedDecryptFailure = false;

function warnOnce(kind: "missing" | "decrypt", message: string): void {
  if (kind === "missing") {
    if (warnedMissingKey) return;
    warnedMissingKey = true;
  } else {
    if (warnedDecryptFailure) return;
    warnedDecryptFailure = true;
  }
  console.warn(`[secrets] ${message}`);
}

function parseKey(raw: string): Buffer {
  const value = raw.trim();
  const isHex = /^[0-9a-fA-F]{64}$/.test(value);
  const isBase64 = /^[A-Za-z0-9+/_-]+={0,2}$/.test(value);
  if (!isHex && !isBase64) {
    throw new Error("ENCRYPTION_KEY 格式不正确:需要 32 字节密钥(base64 或 64 位 hex)");
  }
  const normalized = isHex
    ? value
    : value.replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(normalized, isHex ? "hex" : "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY 长度不正确:需要 ${KEY_BYTES} 字节,实际 ${key.length} 字节`,
    );
  }
  return key;
}

function keyFromEnv(name: string): Buffer | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  return parseKey(raw);
}

/** 是否配置了主密钥。只用于「是否值得跑一次明文迁移」这类判断。 */
export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY?.trim());
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * 加密一个敏感值。空字符串原样返回:没有密钥的账户不应产生一条密文。
 * 配置了密钥但格式错误时抛错,绝不静默退回明文。
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";

  const key = keyFromEnv("ENCRYPTION_KEY");
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境必须设置 ENCRYPTION_KEY,拒绝以明文保存 API Key");
    }
    warnOnce(
      "missing",
      "未配置 ENCRYPTION_KEY,API Key 将以明文保存;生成方式见 .env.example",
    );
    return plaintext;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD, { plaintextLength: Buffer.byteLength(plaintext, "utf8") });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

/**
 * 解密。返回 null 表示密文损坏、被篡改,或用当前/上一把密钥都解不开。
 * 调用方应把这类账户视为「不可用」,而不是拿一段乱码去请求上游。
 */
export function decryptSecret(stored: string): string | null {
  if (!stored) return "";
  // 升级前的明文:原样返回,读取后由仓储层补一次加密回写
  if (!isEncryptedSecret(stored)) return stored;

  const current = keyFromEnv("ENCRYPTION_KEY");
  const previous = keyFromEnv("ENCRYPTION_KEY_PREVIOUS");
  const candidates = [current, previous].filter((key): key is Buffer => Boolean(key));
  if (!candidates.length) {
    warnOnce(
      "decrypt",
      "数据库里是加密后的 API Key,但服务端没有配置 ENCRYPTION_KEY,相关模型将不可用",
    );
    return null;
  }

  const payload = stored.slice(PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, bodyPart] = parts as [string, string, string];
  let iv: Buffer;
  let tag: Buffer;
  let body: Buffer;
  try {
    iv = Buffer.from(ivPart, "base64url");
    tag = Buffer.from(tagPart, "base64url");
    body = Buffer.from(bodyPart, "base64url");
  } catch {
    return null;
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

  for (const key of candidates) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAAD(AAD, { plaintextLength: body.length });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      return plaintext;
    } catch {
      // 换下一把密钥;全部失败时统一返回 null
    }
  }

  warnOnce(
    "decrypt",
    "有 API Key 无法解密(密钥不匹配或密文损坏),相关模型将不可用",
  );
  return null;
}
