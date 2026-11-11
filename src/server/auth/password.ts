/**
 * 口令哈希 —— scrypt,Node 内置,不引第三方依赖。
 *
 * 参数取 OWASP 推荐的 N=2^14, r=8, p=1:单次约 50-80ms,登录可以接受,
 * 暴力破解的代价却高得多。每个用户独立随机盐,哈希串自带参数,
 * 将来调参只需改常量,旧哈希仍能验证。
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keylen, { N, r: R, p: P, maxmem: MAX_MEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N: n, r, p, maxmem: MAX_MEM },
      (error, key) => {
        if (error) reject(error);
        else resolve(key as Buffer);
      },
    );
  }).catch(() => null);
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 账号不存在时也跑一次同等代价的哈希。
 *
 * 否则「邮箱是否注册过」可以通过响应时间差判断 —— 这是最容易被忽略的枚举漏洞。
 */
export async function dummyVerify(password: string): Promise<void> {
  const salt = Buffer.alloc(16, 7);
  await derive(password, salt, KEY_LEN).catch(() => undefined);
}
