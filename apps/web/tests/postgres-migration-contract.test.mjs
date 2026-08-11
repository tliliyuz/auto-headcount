import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationsUrl = new URL("../drizzle/", import.meta.url);

test("PostgreSQL 首批迁移包含同步、原始快照和职位幂等约束", async () => {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrationsUrl), "utf8"),
  );
  assert.equal(journal.dialect, "postgresql");

  const files = (await readdir(migrationsUrl)).filter((name) =>
    name.endsWith(".sql"),
  );
  assert.ok(files.length > 0, "expected at least one PostgreSQL migration");

  const sql = (
    await Promise.all(
      files.map((name) => readFile(new URL(name, migrationsUrl), "utf8")),
    )
  ).join("\n");

  for (const table of [
    "source_connections",
    "sync_runs",
    "raw_records",
    "jobs",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE \\"${table}\\"`));
  }
  assert.match(sql, /payload_ciphertext[\s\S]*bytea/i);
  assert.doesNotMatch(sql, /"payload_(?:ciphertext|nonce)"\s+"bytea"/i);
  assert.match(sql, /UNIQUE[\s\S]*source_connection_id[\s\S]*external_id/i);
  assert.doesNotMatch(sql, /payload_json|payload\s+jsonb/i);
});
