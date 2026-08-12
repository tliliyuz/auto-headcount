import assert from "node:assert/strict";
import test from "node:test";

import { isSameOrigin, requireSameOrigin } from "../../lib/identity/csrf.mjs";

function requestWith(origin) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  return new Request("https://ops.example.com/api/auth/login", {
    method: "POST",
    headers,
  });
}

test("同源 Origin → 放行", () => {
  assert.equal(isSameOrigin(requestWith("https://ops.example.com")), true);
});

test("缺失 Origin（同源导航/curl）→ 放行", () => {
  assert.equal(isSameOrigin(requestWith(undefined)), true);
});

test("跨源 Origin → 拒绝并返回 403 包络", async () => {
  const request = requestWith("https://evil.example.com");
  assert.equal(isSameOrigin(request), false);
  const response = requireSameOrigin(request);
  assert.ok(response);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "forbidden");
});

test("恶意格式 Origin（无法解析）→ 拒绝", () => {
  assert.equal(isSameOrigin(requestWith("not a url")), false);
});
