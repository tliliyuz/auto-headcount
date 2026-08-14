import assert from "node:assert/strict";
import test from "node:test";

import {
  generateLandingToken,
  hashLandingToken,
} from "../../lib/landing/landing-token.mjs";

test("落地页令牌：高熵随机、哈希稳定、不泄露明文", () => {
  const token = generateLandingToken();
  assert.ok(token.length >= 40, "32 字节 base64url 至少 43 字符");
  assert.match(token, /^[A-Za-z0-9_-]+$/);

  const hash = hashLandingToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/, "SHA-256 应为 64 位十六进制");
  assert.notEqual(hash, token);
  assert.ok(!hash.includes(token.slice(0, 8)), "哈希不应包含明文前缀");

  assert.equal(hashLandingToken(token), hash, "同令牌哈希稳定");
  assert.notEqual(hashLandingToken(`${token}x`), hash, "不同令牌哈希不同");
  assert.notEqual(generateLandingToken(), token, "两次生成不同");
});
