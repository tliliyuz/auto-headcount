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

test("迁移 0008 包含两阶段匹配表与 matches/match_dimensions 扩展", async () => {
  const migrationsUrl = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(migrationsUrl)).filter((name) =>
    name.endsWith(".sql"),
  );
  const sql = (
    await Promise.all(
      files.map((name) => readFile(new URL(name, migrationsUrl), "utf8")),
    )
  ).join("\n");

  // 四张两阶段匹配表
  for (const table of [
    "job_match_projections",
    "candidate_match_projections",
    "match_filter_results",
    "llm_score_runs",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE \\"${table}\\"`));
  }

  // 投影不可变：唯一约束含 input_hash（源内容哈希，版本不覆盖）
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "job_match_projections_immutable_unique".*job_id.*schema_version.*generator_version.*input_hash/s,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "candidate_match_projections_immutable_unique".*candidate_id.*schema_version.*generator_version.*redaction_version.*input_hash/s,
  );

  // 候选人投影脱敏详情加密列
  assert.match(sql, /"redacted_detail_ciphertext"\s+"bytea"/i);
  assert.doesNotMatch(sql, /"redacted_detail_ciphertext"\s+(text|jsonb)/i);

  // 硬过滤结果不可变：同投影对 + 规则版本幂等
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "match_filter_results_immutable_unique".*job_projection_id.*candidate_projection_id.*filter_rule_version/s,
  );

  // matches/match_dimensions 扩展列（两阶段追溯）
  for (const col of [
    "job_projection_id",
    "candidate_projection_id",
    "filter_result_id",
    "llm_score_run_id",
    "aggregation_rule_version",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE "matches" ADD COLUMN "${col}"`));
  }
  for (const col of ["assessable", "confidence", "llm_score_run_id", "output_hash"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "match_dimensions" ADD COLUMN "${col}"`));
  }
});

test("迁移 0009 持久化浏览器采集批次、断点和唯一发现条目", async () => {
  const files = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql"));
  const sql = (await Promise.all(files.map((name) => readFile(new URL(name, migrationsUrl), "utf8")))).join("\n");
  assert.match(sql, /CREATE TABLE "browser_collection_batches"/);
  assert.match(sql, /"next_page" integer/);
  assert.match(sql, /CREATE TABLE "browser_collection_items"/);
  assert.match(sql, /CREATE UNIQUE INDEX "browser_collection_items_batch_external_unique".*batch_id.*external_id/s);
});

test("迁移 0010 补候选人来源追溯/近期工作列并新增候选批次表", async () => {
  const files = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql"));
  const sql = (await Promise.all(files.map((name) => readFile(new URL(name, migrationsUrl), "utf8")))).join("\n");
  // candidates 补来源追溯（对齐 jobs）
  assert.match(sql, /ALTER TABLE "candidates" ADD COLUMN "source_connection_id"/);
  assert.match(sql, /ALTER TABLE "candidates" ADD COLUMN "raw_record_id"/);
  // 幂等冲突目标改为 (source_connection_id, external_id)
  assert.match(sql, /CREATE UNIQUE INDEX "candidates_source_external_unique".*source_connection_id.*external_id/s);
  // 近期工作列（投影 current_title ?? seniority 回退来源）
  assert.match(sql, /ALTER TABLE "candidate_profiles" ADD COLUMN "current_title"/);
  assert.match(sql, /ALTER TABLE "candidate_profiles" ADD COLUMN "current_company"/);
  // 候选批次表 + 唯一发现条目
  assert.match(sql, /CREATE TABLE "browser_candidate_batches"/);
  assert.match(sql, /CREATE TABLE "browser_candidate_items"/);
  assert.match(sql, /CREATE UNIQUE INDEX "browser_candidate_items_batch_external_unique".*batch_id.*external_id/s);
});
