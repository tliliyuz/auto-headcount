import assert from "node:assert/strict";
import test from "node:test";

import { authorizeOrForbidden } from "../../lib/identity/authz.mjs";

const ALLOWED_ROLES = ["operations", "admin"];

test("operations 与 admin 允许访问业务只读端点", () => {
  assert.equal(
    authorizeOrForbidden({ roles: ["operations"] }, ALLOWED_ROLES),
    null,
  );
  assert.equal(authorizeOrForbidden({ roles: ["admin"] }, ALLOWED_ROLES), null);
  // 命中任一允许角色即放行（多角色用户含 operations）
  assert.equal(
    authorizeOrForbidden({ roles: ["recruiter", "operations"] }, ALLOWED_ROLES),
    null,
  );
});

test("recruiter、空角色与无用户一律返回 403", async () => {
  for (const user of [{ roles: ["recruiter"] }, { roles: [] }, null, undefined]) {
    const response = authorizeOrForbidden(user, ALLOWED_ROLES);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "forbidden");
    assert.equal(typeof body.message, "string");
  }
});

test("自定义拒绝文案生效", async () => {
  const response = authorizeOrForbidden({ roles: ["recruiter"] }, ALLOWED_ROLES, {
    message: "仅招聘运营或管理员可查看",
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.message, "仅招聘运营或管理员可查看");
});
