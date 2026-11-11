/**
 * 敏感字段加密校验。
 *
 * 覆盖:格式、随机 IV、篡改检测、旧明文兼容、密钥轮换、错误密钥与缺失密钥的行为。
 * 不依赖数据库,纯函数级验证;数据库落地由 check-db 覆盖。
 */

import { randomBytes } from "node:crypto";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const { encryptSecret, decryptSecret, isEncryptedSecret } = await import(
    "../src/server/security/secrets"
  );

  const key = randomBytes(32).toString("base64");
  process.env.ENCRYPTION_KEY = key;
  delete process.env.ENCRYPTION_KEY_PREVIOUS;

  const plaintext = "sk-live-测试-0123456789";
  const sealed = encryptSecret(plaintext);
  expect("密文带版本前缀", sealed.startsWith("enc:v1:"), sealed.slice(0, 12));
  expect("密文不包含原文", !sealed.includes(plaintext));
  expect("可解密回原文", decryptSecret(sealed) === plaintext, String(decryptSecret(sealed)));
  expect("前缀识别", isEncryptedSecret(sealed) && !isEncryptedSecret(plaintext));

  const sealedAgain = encryptSecret(plaintext);
  expect("同一明文两次密文不同(随机 IV)", sealed !== sealedAgain);

  const long = "x".repeat(20_000);
  expect("长文本可往返", decryptSecret(encryptSecret(long)) === long);
  expect("中文可往返", decryptSecret(encryptSecret("密钥-中文-🙂")) === "密钥-中文-🙂");

  expect("空值保持空", encryptSecret("") === "" && decryptSecret("") === "");
  expect("旧明文原样读取", decryptSecret("sk-legacy-plain") === "sk-legacy-plain");

  // 不要改最后一个 base64 字符:尾部可能只有填充位,换成 A/B 不一定改变解码结果。
  // 改 IV 的第一个字符,密文一定不同。
  const tampered = sealed.replace(/^(enc:v1:)(.)/, (_, prefix: string, first: string) =>
    `${prefix}${first === "A" ? "B" : "A"}`,
  );
  expect("篡改密文解不开", decryptSecret(tampered) === null);

  const wrongKey = randomBytes(32).toString("base64");
  process.env.ENCRYPTION_KEY = wrongKey;
  expect("错误密钥解不开", decryptSecret(sealed) === null);

  process.env.ENCRYPTION_KEY_PREVIOUS = key;
  expect("轮换后旧密钥仍可解密", decryptSecret(sealed) === plaintext);
  delete process.env.ENCRYPTION_KEY_PREVIOUS;

  process.env.ENCRYPTION_KEY = "too-short";
  let invalidThrew = false;
  try {
    encryptSecret("sk-test");
  } catch {
    invalidThrew = true;
  }
  expect("非法密钥拒绝加密", invalidThrew);

  let invalidDecryptThrew = false;
  try {
    decryptSecret(sealed);
  } catch {
    invalidDecryptThrew = true;
  }
  expect("非法密钥拒绝解密", invalidDecryptThrew);

  delete process.env.ENCRYPTION_KEY;
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  env.NODE_ENV = "development";
  expect("开发环境缺失密钥退回明文", encryptSecret("sk-dev") === "sk-dev");
  expect("缺失密钥时密文不可用", decryptSecret(sealed) === null);
  if (previousNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = previousNodeEnv;

  if (problems.length > 0) {
    console.error("加密校验失败:\n" + problems.map((problem) => `  x ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log(`密钥加密一致(AES-256-GCM / 随机 IV / 篡改检测 / 轮换 / 兼容 共 ${checks} 项)`);
}

main().catch((error: unknown) => {
  console.error("加密校验崩溃:", error);
  process.exit(1);
});
