import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBase32,
  generateTOTP,
  generateTOTPSecret,
  totpProvisioningUri,
  verifyTOTP,
} from "../../lib/identity/totp.mjs";

// RFC 6238 附录 B 测试向量：secret = base32('12345678901234567890')
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("RFC 6238 已知向量：6 位 OTP 与官方表一致", async () => {
  // T 为 Unix 秒；generateTOTP 以毫秒接收 now
  const vectors = [
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(await generateTOTP(RFC_SECRET, { now: t * 1000 }), expected);
  }
});

test("verifyTOTP 接受当前窗口与 ±1 步偏移，拒绝错误码", async () => {
  const now = 1234567890 * 1000;
  const current = await generateTOTP(RFC_SECRET, { now });
  assert.equal(await verifyTOTP(RFC_SECRET, current, { now }), true);

  // 前/后 30 秒窗口在 window=1 内仍通过
  const prev = await generateTOTP(RFC_SECRET, { now: now - 30_000 });
  const next = await generateTOTP(RFC_SECRET, { now: now + 30_000 });
  assert.equal(await verifyTOTP(RFC_SECRET, prev, { now }), true);
  assert.equal(await verifyTOTP(RFC_SECRET, next, { now }), true);

  // 错误码被拒绝
  assert.equal(await verifyTOTP(RFC_SECRET, "000000", { now }), false);
  // 过期两个窗口之外被拒绝
  const far = await generateTOTP(RFC_SECRET, { now: now - 90_000 });
  assert.equal(await verifyTOTP(RFC_SECRET, far, { now }), false);
});

test("generateTOTPSecret 返回 20 字节 base32（32 字符），且每次随机不同", () => {
  const a = generateTOTPSecret();
  const b = generateTOTPSecret();
  assert.equal(a.length, 32);
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
  assert.equal(decodeBase32(a).length, 20);
});

test("generateTOTPSecret 生成的密钥可生成并校验通过（round-trip）", async () => {
  const secret = generateTOTPSecret();
  const now = 1234567890 * 1000;
  const code = await generateTOTP(secret, { now });
  assert.equal(await verifyTOTP(secret, code, { now }), true);
});

test("decodeBase32 兼容标准 base32 padding，TOTP 校验带 padding 的 secret 不再抛错", async () => {
  // 标准 base32('foobar') = "MZXW6YTBOI======"（6 字节 → 10 字符 + 6 padding）
  assert.deepEqual(
    Array.from(decodeBase32("MZXW6YTBOI======")),
    [102, 111, 111, 98, 97, 114],
  );
  // 带 padding 与不带 padding 的 secret 校验结果一致
  const now = 1_700_000_000_000;
  const code = await generateTOTP("MZXW6YTBOI", { now });
  assert.equal(await verifyTOTP("MZXW6YTBOI======", code, { now }), true);
});

test("totpProvisioningUri 生成标准 otpauth URI 并正确 URL 编码", () => {
  const uri = totpProvisioningUri({
    secret: "GEZDGNBVGY3TQOJQ",
    accountName: "admin",
    issuer: "Auto Headcount",
  });
  assert.equal(
    uri,
    "otpauth://totp/Auto%20Headcount:admin?secret=GEZDGNBVGY3TQOJQ&issuer=Auto+Headcount",
  );
});
