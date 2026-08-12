import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../../scripts/seed-dev-users.mjs", import.meta.url),
);

test("seed-dev-users 在非 development 环境拒绝执行（Fixture 登录门禁）", () => {
  for (const appEnv of ["test", "production"]) {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, APP_ENV: appEnv, DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, `${appEnv} 应非零退出`);
    assert.match(result.stderr ?? "", /development/);
    assert.doesNotMatch(result.stderr ?? "", /postgres/i, "门禁应在连接数据库前拒绝");
  }
});
