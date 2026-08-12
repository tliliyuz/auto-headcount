import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../../scripts/init-admin.mjs", import.meta.url),
);

test("init-admin 仅在 production 环境执行（非 production 拒绝且连接数据库前退出）", () => {
  for (const appEnv of ["development", "test"]) {
    const result = spawnSync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        APP_ENV: appEnv,
        DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x",
        ADMIN_INIT_PASSWORD: "TempPass2026!",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, `${appEnv} 应非零退出`);
    assert.match(result.stderr ?? "", /production/);
    assert.doesNotMatch(result.stderr ?? "", /postgres/i, "门禁应在连接数据库前拒绝");
  }
});

test("init-admin production 下缺少 ADMIN_INIT_PASSWORD 拒绝", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      APP_ENV: "production",
      DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr ?? "", /ADMIN_INIT_PASSWORD/);
});
