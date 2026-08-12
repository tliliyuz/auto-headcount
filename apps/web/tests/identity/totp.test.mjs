import assert from "node:assert/strict";
import test from "node:test";

import { generateTOTP, verifyTOTP } from "../../lib/identity/totp.mjs";

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
