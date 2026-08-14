import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserJobCollectionError,
  evaluateBrowserJobEligibility,
  parseBrowserJobCollectTaskPayload,
  parseBrowserJobBatchDiscoverTaskPayload,
  runBrowserJobBatchDiscovery,
  runBrowserJobCollection,
} from "../lib/jobs/browser-job-collection.mjs";

const task = {
  sourceConnectionId: "11111111-1111-4111-8111-111111111111",
  userId: "fixture-user",
  deviceId: "fixture-device",
  contractId: "liebide-job-detail-v1",
  externalId: "fixture-job-001",
  expectedTitle: "虚构数据工程师",
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

test("browser_job_collect 任务载荷携带发现阶段的期望标题并拒绝非法标题", () => {
  assert.deepEqual(parseBrowserJobCollectTaskPayload(task), task);
  for (const expectedTitle of ["", "   ", "x".repeat(501)]) {
    assert.throws(
      () => parseBrowserJobCollectTaskPayload({ ...task, expectedTitle }),
      BrowserJobCollectionError,
    );
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

test("单职位闭环允许同源 WRONG_ENTITY 进入固定导航且规则合格时持久化", async () => {
  const calls = [];
  const result = await runBrowserJobCollection({
    task, now: new Date("2026-08-13T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus(input) { calls.push(["preflight", input]); return {
        status: "WRONG_ENTITY", ready: false, sessionMatched: true,
        origin: "https://portal.liebide.com", authState: "authenticated",
      }; },
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
  assert.equal(calls[1][1].contractId, "liebide-job-detail-v1");
  assert.equal(calls[1][1].expectedExternalId, task.externalId);
  assert.equal(calls[2][1].expectedTitle, task.expectedTitle);
  assert.equal(calls[3][1].job.ageDays, 9);
});

test("未登录等非导航状态和不合格回执禁止持久化", async () => {
  let extracted = false;
  let persisted = false;
  const blocked = await runBrowserJobCollection({
    task, now: new Date("2026-08-13T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus() { return { status: "AUTH_REQUIRED", ready: false }; },
      async extractJobDetail() { extracted = true; },
    },
    repository: {
      async sourceExists() { return true; },
      async persist() { persisted = true; },
    },
  });
  assert.equal(blocked.errorCode, "BROWSER_AUTH_REQUIRED");
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

test("批量发现任务载荷有界且不接受 session、URL、选择器或提示词", () => {
  const input = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId,
    deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2",
    batchSize: 20,
    maxPages: 3,
  };
  assert.deepEqual(parseBrowserJobBatchDiscoverTaskPayload(input), input);
  for (const extra of [
    { browserSessionId: "forbidden" }, { url: "https://portal.liebide.com" },
    { selector: ".job" }, { prompt: "请翻页" },
  ]) assert.throws(() => parseBrowserJobBatchDiscoverTaskPayload({ ...input, ...extra }), BrowserJobCollectionError);
});

test("批量发现先验证当前筛选列表，再持久化唯一条目并创建详情任务", async () => {
  const calls = [];
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 20, maxPages: 3,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus(input) { calls.push(["preflight", input]); return { status: "READY", ready: true }; },
      async discoverFilteredJobs(input) { calls.push(["discover", input]); return {
        items: [
          { externalId: "fixture-job-001", title: "虚构职位一", pageNumber: 1, position: 1 },
          { externalId: "fixture-job-002", title: "虚构职位二", pageNumber: 1, position: 2 },
        ],
        nextPage: 2, stopReason: "max_pages", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { calls.push(["source"]); return true; },
      async persistDiscovery(input) { calls.push(["persist", input]); return { createdItems: 2, enqueuedDetails: 2 }; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.discovered, 2);
  assert.deepEqual(calls.map(([name]) => name), ["source", "preflight", "discover", "persist"]);
  assert.equal(calls[3][1].detailContractId, "liebide-job-detail-v1");
});
