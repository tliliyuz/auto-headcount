import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserJobCollectionError,
  evaluateBrowserJobEligibility,
  parseBrowserJobCollectTaskPayload,
  runBrowserJobCollection,
} from "../lib/jobs/browser-job-collection.mjs";

const task = {
  sourceConnectionId: "11111111-1111-4111-8111-111111111111",
  userId: "fixture-user",
  deviceId: "fixture-device",
  contractId: "liebide-job-detail-v1",
  externalId: "fixture-job-001",
};

function record(overrides = {}) {
  return {
    contractId: "liebide-job-detail-v1", contractVersion: 1,
    sourceOrigin: "https://portal.liebide.com",
    capturedAt: "2026-08-13T09:00:00.000Z", contentHash: "a".repeat(64),
    externalId: "fixture-job-001", title: "虚构数据工程师", status: "active",
    city: "上海", salaryMin: 20000, salaryMax: 30000,
    jobDescription: "完全虚构的职位描述。",
    publishedAt: "2026-08-04T09:00:00.000Z", validRecommendationCount: 0,
    ...overrides,
  };
}

test("browser_job_collect 任务载荷关闭字段且禁止持久化 browser session", () => {
  assert.deepEqual(parseBrowserJobCollectTaskPayload(task), task);
  for (const extra of [
    { browserSessionId: "must-not-persist" },
    { url: "https://portal.liebide.com" },
    { script: "document.body.innerText" },
  ]) {
    assert.throws(() => parseBrowserJobCollectTaskPayload({ ...task, ...extra }), BrowserJobCollectionError);
  }
});

test("本地沉睡规则包含 7/30 天并拒绝缺失或不合格事实", () => {
  const now = new Date("2026-08-13T09:00:00.000Z");
  assert.equal(evaluateBrowserJobEligibility(record(), now).eligible, true);
  assert.equal(evaluateBrowserJobEligibility(record({ publishedAt: "2026-08-06T09:00:00.000Z" }), now).ageDays, 7);
  assert.equal(evaluateBrowserJobEligibility(record({ publishedAt: "2026-07-14T09:00:00.000Z" }), now).ageDays, 30);
  for (const candidate of [
    record({ publishedAt: "2026-08-07T09:00:00.000Z" }),
    record({ publishedAt: "2026-07-13T09:00:00.000Z" }),
    record({ publishedAt: null }), record({ status: "closed" }),
    record({ validRecommendationCount: null }), record({ validRecommendationCount: 1 }),
  ]) assert.equal(evaluateBrowserJobEligibility(candidate, now).eligible, false);
});

test("单职位闭环只有 READY 且规则合格时才持久化", async () => {
  const calls = [];
  const result = await runBrowserJobCollection({
    task, now: new Date("2026-08-13T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus(input) { calls.push(["preflight", input]); return { status: "READY", ready: true }; },
      async extractJobDetail(input) { calls.push(["extract", input]); return record(); },
    },
    repository: {
      async sourceExists(id) { calls.push(["source", id]); return true; },
      async persist(input) { calls.push(["persist", input]); return { jobId: "fixture-job", rawRecordId: "fixture-raw" }; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.persisted, 1);
  assert.deepEqual(calls.map(([name]) => name), ["source", "preflight", "extract", "persist"]);
  assert.equal(calls[1][1].browserSessionId, undefined);
  assert.equal(calls[3][1].job.ageDays, 9);
});

test("非 READY 和不合格回执禁止持久化", async () => {
  let extracted = false;
  let persisted = false;
  const blocked = await runBrowserJobCollection({
    task, now: new Date("2026-08-13T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus() { return { status: "WRONG_ENTITY", ready: false }; },
      async extractJobDetail() { extracted = true; },
    },
    repository: {
      async sourceExists() { return true; },
      async persist() { persisted = true; },
    },
  });
  assert.equal(blocked.errorCode, "BROWSER_WRONG_ENTITY");
  assert.equal(extracted, false);
  assert.equal(persisted, false);

  const skipped = await runBrowserJobCollection({
    task, now: new Date("2026-08-13T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async extractJobDetail() { return record({ validRecommendationCount: 1 }); },
    },
    repository: {
      async sourceExists() { return true; },
      async persist() { persisted = true; },
    },
  });
  assert.equal(skipped.status, "succeeded");
  assert.equal(skipped.stats.skipped, 1);
  assert.equal(persisted, false);
});
