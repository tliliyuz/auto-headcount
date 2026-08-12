import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  clearSessionCookie,
  generateSessionToken,
  hashSessionToken,
  sessionCookieValue,
} from "../../lib/identity/session-token.mjs";

test("generateSessionToken 产出高熵令牌且哈希一致", async () => {
  const a = await generateSessionToken();
  const b = await generateSessionToken();
  assert.equal(a.token.length >= 32, true, "token 至少 32 字节编码");
  assert.notEqual(a.token, b.token);
  assert.equal(a.tokenHash, await hashSessionToken(a.token));
  assert.notEqual(a.tokenHash, a.token, "数据库存哈希而非令牌");
});

test("会话 Cookie 具备 HttpOnly/SameSite=Lax/Path=/ 属性", () => {
  const value = sessionCookieValue("abc", {
    maxAgeSeconds: 43200,
    secure: true,
  });
  assert.match(value, new RegExp(`^${SESSION_COOKIE_NAME}=abc;`));
  assert.match(value, /HttpOnly/i);
  assert.match(value, /SameSite=Lax/i);
  assert.match(value, /Path=\//i);
  assert.match(value, /Secure/i);
  assert.match(value, /Max-Age=43200/i);
});

test("开发环境可不带 Secure，登出 Cookie 立即过期", () => {
  const insecure = sessionCookieValue("abc", {
    maxAgeSeconds: 43200,
    secure: false,
  });
  assert.doesNotMatch(insecure, /Secure/i);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test("空闲与最长有效期常量符合规范", () => {
  assert.equal(SESSION_IDLE_MS, 30 * 60 * 1000);
  assert.equal(SESSION_MAX_MS, 12 * 60 * 60 * 1000);
});
