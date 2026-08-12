import assert from "node:assert/strict";
import test from "node:test";

import { passwordChangeBlockResponse } from "../../lib/server/with-audit-gate.mjs";

test("需改密的会话访问业务只读端点 → 403 password_change_required", async () => {
  const response = passwordChangeBlockResponse(
    { user: { id: "u1" }, roles: ["admin"], passwordChangeRequired: true },
    ["operations", "admin"],
  );
  assert.ok(response instanceof Response);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "password_change_required");
});

test("已改密会话 → 放行（null）", () => {
  assert.equal(
    passwordChangeBlockResponse(
      { user: { id: "u1" }, roles: ["admin"], passwordChangeRequired: false },
      ["operations", "admin"],
    ),
    null,
  );
});

test("无 allowedRoles（认证路由形态）不受门禁影响", () => {
  assert.equal(
    passwordChangeBlockResponse(
      { user: { id: "u1" }, roles: ["admin"], passwordChangeRequired: true },
      undefined,
    ),
    null,
  );
  assert.equal(
    passwordChangeBlockResponse(
      { user: { id: "u1" }, roles: ["admin"], passwordChangeRequired: true },
      [],
    ),
    null,
  );
});
