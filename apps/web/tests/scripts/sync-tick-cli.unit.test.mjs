import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(
  new URL("../../scripts/run-scheduled-tick.mjs", import.meta.url),
);

function runCli(envOverrides, args = []) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
  });
}

test("缺 DATABASE_URL → exit 2 且 stderr 含 DATABASE_URL_REQUIRED", () => {
  const result = runCli({
    DATABASE_URL: "",
    APP_ENCRYPTION_KEY: "k",
    APP_ENCRYPTION_KEY_VERSION: "v",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DATABASE_URL_REQUIRED/);
});

test("缺加密 key → exit 2 且 stderr 含 ENCRYPTION_CONFIG_REQUIRED", () => {
  const result = runCli({
    DATABASE_URL: "postgresql://unused.example/db",
    APP_ENCRYPTION_KEY: "",
    APP_ENCRYPTION_KEY_VERSION: "",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ENCRYPTION_CONFIG_REQUIRED/);
});

test("--interval-minutes 非法值 → exit 2 且 stderr 含 INVALID_INTERVAL", () => {
  const result = runCli(
    { DATABASE_URL: "postgresql://unused.example/db" },
    ["--loop", "--interval-minutes", "abc"],
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /INVALID_INTERVAL/);
});

test("--interval-minutes 为 0 → exit 2", () => {
  const result = runCli(
    { DATABASE_URL: "postgresql://unused.example/db" },
    ["--loop", "--interval-minutes", "0"],
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /INVALID_INTERVAL/);
});
