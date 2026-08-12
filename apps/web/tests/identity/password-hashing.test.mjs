import assert from "node:assert/strict";
import test from "node:test";

import {
  BCRYPT_COST,
  hashPassword,
  verifyPassword,
} from "../../lib/identity/password-hashing.mjs";

test("hashPassword 产出 bcrypt 哈希且不含明文", async () => {
  const hash = await hashPassword("OpsPass2026!");
  assert.match(hash, /^\$2[aby]\$12\$/);
  assert.doesNotMatch(hash, /OpsPass2026/);
});

test("verifyPassword 正确/错误口令分别返回 true/false", async () => {
  const hash = await hashPassword("OpsPass2026!");
  assert.equal(await verifyPassword("OpsPass2026!", hash), true);
  assert.equal(await verifyPassword("WrongPass2026!", hash), false);
});

test("BCRYPT_COST 为 12", () => {
  assert.equal(BCRYPT_COST, 12);
});
