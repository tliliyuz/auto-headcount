import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseUnderServedJobsResult,
  selectEligibleUnderServedJobs,
} from "../lib/adapters/mcp-under-served-contract.mjs";

const fixtureUrl = new URL(
  "../fixtures/mcp/under-served-response-2026-08-11.json",
  import.meta.url,
);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("解析真实响应形状并保留供应商筛选证据", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());

  assert.equal(page.total, 1);
  assert.equal(page.jobs[0].externalId, "fixture-job-001");
  assert.equal(page.jobs[0].ageDays, 7);
  assert.equal(page.jobs[0].sourceCreatedAt, null);
  assert.deepEqual(page.jobs[0].eligibilityEvidence, {
    activeStatus: "provider_filter",
    zeroRecommendations: "provider_filter",
    age: "days_without_rec",
  });
});

test("本地业务规则包含 7 和 30，排除 31 天", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());
  const base = page.jobs[0];

  assert.deepEqual(
    selectEligibleUnderServedJobs({
      ...page,
      jobs: [
        { ...base, externalId: "day-7", ageDays: 7 },
        { ...base, externalId: "day-30", ageDays: 30 },
        { ...base, externalId: "day-31", ageDays: 31 },
      ],
    }).map((job) => job.externalId),
    ["day-7", "day-30"],
  );
});

test("字段类型漂移时明确失败，不把无效响应写入业务模型", async () => {
  const fixture = await loadFixture();
  const payload = JSON.parse(fixture.content[0].text);
  payload.Data.list[0].days_without_rec = "7";
  fixture.content[0].text = JSON.stringify(payload);

  assert.throws(
    () => parseUnderServedJobsResult(fixture),
    (error) => {
      assert.equal(error.code, "MCP_CONTRACT_INVALID");
      assert.match(error.message, /days_without_rec/);
      return true;
    },
  );
});
