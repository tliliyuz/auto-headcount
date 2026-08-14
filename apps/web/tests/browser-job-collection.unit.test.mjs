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
import { createCsdnBrowserRelayClient } from "../lib/adapters/csdn-browser/relay-client.mjs";

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
        nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { calls.push(["source"]); return true; },
      async findKnownExternalIds({ sourceConnectionId }) { calls.push(["known", sourceConnectionId]); return []; },
      async persistDiscovery(input) { calls.push(["persist", input]); return { createdItems: 2, enqueuedDetails: 2 }; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.discovered, 2);
  assert.deepEqual(calls.map(([name]) => name), ["source", "known", "preflight", "discover", "persist"]);
  assert.equal(calls[4][1].detailContractId, "liebide-job-detail-v1");
});

test("差分发现跳过已入库未变职位、只采集新增，凑满目标即停", async () => {
  const calls = [];
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 1, maxPages: 20,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { calls.push(["preflight"]); return { status: "READY", ready: true }; },
      async discoverFilteredJobs(input) { calls.push(["discover", input]); return {
        items: [
          { externalId: "fixture-job-001", title: "虚构职位一", pageNumber: 1, position: 1 },
          { externalId: "fixture-job-002", title: "虚构职位二", pageNumber: 1, position: 2 },
        ],
        nextPage: 2, nextOffset: 0, stopReason: "batch_size", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { calls.push(["source"]); return true; },
      async findKnownExternalIds() { calls.push(["known"]); return [{ externalId: "fixture-job-001", title: "虚构职位一" }]; },
      async persistDiscovery(input) {
        calls.push(["persist", input]);
        return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 1);
  assert.equal(result.stats.skippedKnown, 1);
  assert.equal(result.stats.discovered, 2);
  assert.equal(result.stats.stopReason, "target_reached");
  assert.equal(calls.filter(([name]) => name === "discover").length, 1);
  const persisted = calls.find(([name]) => name === "persist")[1];
  assert.deepEqual(persisted.discovery.items.map((i) => i.externalId), ["fixture-job-002"]);
});

test("已入库但标题变化的职位按变更重新采集", async () => {
  const calls = [];
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 1, maxPages: 3,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async discoverFilteredJobs() { calls.push(["discover"]); return {
        items: [{ externalId: "fixture-job-001", title: "新标题", pageNumber: 1, position: 1 }],
        nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { return true; },
      async findKnownExternalIds() { return [{ externalId: "fixture-job-001", title: "旧标题" }]; },
      async persistDiscovery(input) {
        calls.push(["persist", input]);
        return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 1);
  assert.equal(result.stats.skippedKnown, 0);
  const persisted = calls.find(([name]) => name === "persist")[1];
  assert.deepEqual(persisted.discovery.items.map((i) => i.externalId), ["fixture-job-001"]);
  assert.equal(persisted.discovery.items[0].title, "新标题");
});

test("凑不满目标时按数字断点向后翻页", async () => {
  const calls = [];
  const discoverResponses = [
    {
      items: [{ externalId: "fixture-job-001", title: "虚构职位一", pageNumber: 1, position: 1 }],
      nextPage: 2, nextOffset: 0, stopReason: "batch_size", pagesVisited: 1,
    },
    {
      items: [
        { externalId: "fixture-job-002", title: "虚构职位二", pageNumber: 2, position: 1 },
        { externalId: "fixture-job-003", title: "虚构职位三", pageNumber: 2, position: 2 },
      ],
      nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
    },
  ];
  let responseIndex = 0;
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 2, maxPages: 20,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async discoverFilteredJobs(input) { calls.push(["discover", input]); return discoverResponses[responseIndex++]; },
    },
    repository: {
      async sourceExists() { return true; },
      async findKnownExternalIds() { return [{ externalId: "fixture-job-001", title: "虚构职位一" }]; },
      async persistDiscovery(input) {
        calls.push(["persist", input]);
        return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 2);
  assert.equal(result.stats.skippedKnown, 1);
  assert.equal(result.stats.pages, 2);
  assert.equal(calls.filter(([name]) => name === "discover").length, 2);
  assert.equal(calls.filter(([name]) => name === "discover")[1][1].startPage, 2);
  const persisted = calls.find(([name]) => name === "persist")[1];
  assert.deepEqual(persisted.discovery.items.map((i) => i.externalId), ["fixture-job-002", "fixture-job-003"]);
});

test("批量发现预检经真实 Relay 客户端必须携带 batchSize/maxPages（列表合同连接状态白名单要求）", async () => {
  const preflightCalls = [];
  const relayClient = createCsdnBrowserRelayClient({
    requestUrl: "https://codeg.invalid/api/csdn_browser_relay/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.tool === "csdn_get_browser_connection_status") {
        preflightCalls.push(request);
        return Response.json({ ok: true, result: {
          status: "READY", ready: true, action: "none", registeredPageCount: 1,
          sessionMatched: true, origin: "https://portal.liebide.com", authState: "authenticated",
          contractId: "liebide-filtered-job-list-v2", entityMatched: false,
        } });
      }
      return Response.json({ ok: true, result: {
        contractId: "liebide-filtered-job-list-v2", contractVersion: 2, status: "extracted",
        source: { origin: "https://portal.liebide.com", capturedAt: "2026-08-13T09:00:00.000Z" },
        filterEvidence: { recommendationCount: 0, publishedAgeDaysMin: 0, publishedAgeDaysMax: 30 },
        items: [],
        page: { startPage: 1, startOffset: 0, endPage: 1, pagesVisited: 1, nextPage: null, nextOffset: null, stopReason: "end_of_results" },
        contentHash: "b".repeat(64),
      } });
    },
  });
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 20, maxPages: 20,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient,
    repository: {
      async sourceExists() { return true; },
      async findKnownExternalIds() { return []; },
      async persistDiscovery(input) { return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length }; },
    },
  });
  // 预检参数经 buildFilteredJobListConnectionStatusArguments 白名单校验；
  // 缺少 batchSize/maxPages 会抛 BROWSER_COLLECTION_ARGUMENTS_INVALID（回归防护）。
  assert.equal(preflightCalls.length, 1);
  assert.equal(result.status, "succeeded");
});

test("全部已知且标题未变时本批采集 0 条并正常结束", async () => {
  const calls = [];
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-filtered-job-list-v2", batchSize: 5, maxPages: 20,
  };
  const result = await runBrowserJobBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async discoverFilteredJobs() { calls.push(["discover"]); return {
        items: [{ externalId: "fixture-job-001", title: "虚构职位一", pageNumber: 1, position: 1 }],
        nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { return true; },
      async findKnownExternalIds() { return [{ externalId: "fixture-job-001", title: "虚构职位一" }]; },
      async persistDiscovery(input) {
        calls.push(["persist", input]);
        return { createdItems: 0, enqueuedDetails: 0 };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 0);
  assert.equal(result.stats.skippedKnown, 1);
  const persisted = calls.find(([name]) => name === "persist")[1];
  assert.deepEqual(persisted.discovery.items, []);
});
