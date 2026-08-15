import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCandidateCollectionError,
  mapCandidateRecordToEntities,
  parseBrowserCandidateBatchDiscoverTaskPayload,
  parseBrowserCandidateCollectTaskPayload,
  runBrowserCandidateBatchDiscovery,
  runBrowserCandidateCollection,
} from "../lib/jobs/browser-candidate-collection.mjs";

const task = {
  sourceConnectionId: "11111111-1111-4111-8111-111111111111",
  userId: "fixture-user",
  deviceId: "fixture-device",
  contractId: "liebide-candidate-detail-v1",
  externalId: "fixture-cand-001",
  expectedTitle: "数据工程师",
};

function detailRecord(overrides = {}) {
  return {
    contractId: "liebide-candidate-detail-v1", contractVersion: 1,
    sourceOrigin: "https://portal.liebide.com",
    capturedAt: "2026-08-14T09:00:00.000Z", contentHash: "a".repeat(64),
    candidateId: "fixture-cand-001", realName: "示例候选人甲",
    title: "数据工程师", company: "虚构科技", yearOfExperience: 8,
    cityName: "北京", school: "虚构大学", major: "计算机", degree: "本科",
    completion: 80, recommendationCount: 3,
    workExperiences: [{ company: "虚构科技", title: "数据工程师" }],
    ...overrides,
  };
}

test("browser_candidate_collect 任务载荷关闭字段且不接受 session/URL/脚本", () => {
  assert.deepEqual(parseBrowserCandidateCollectTaskPayload(task), task);
  for (const extra of [
    { browserSessionId: "must-not-persist" },
    { url: "https://portal.liebide.com" },
    { script: "document.body.innerText" },
  ]) {
    assert.throws(() => parseBrowserCandidateCollectTaskPayload({ ...task, ...extra }), BrowserCandidateCollectionError);
  }
  assert.throws(() => parseBrowserCandidateCollectTaskPayload({ ...task, contractId: "liebide-filtered-job-list-v2" }), BrowserCandidateCollectionError);
});

test("browser_candidate_discovery 任务载荷有界且契约固定为人才池列表", () => {
  const input = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-talent-pool-list-v1", batchSize: 20, maxPages: 3,
  };
  assert.deepEqual(parseBrowserCandidateBatchDiscoverTaskPayload(input), input);
  for (const extra of [
    { browserSessionId: "forbidden" }, { url: "https://portal.liebide.com" },
    { selector: ".candidate" }, { prompt: "请翻页" },
  ]) assert.throws(() => parseBrowserCandidateBatchDiscoverTaskPayload({ ...input, ...extra }), BrowserCandidateCollectionError);
  assert.throws(() => parseBrowserCandidateBatchDiscoverTaskPayload({ ...input, contractId: "liebide-candidate-detail-v1" }), BrowserCandidateCollectionError);
});

test("候选人详情闭环：预检 → 新标签页提取 → 真实姓名/画像入库", async () => {
  const calls = [];
  const result = await runBrowserCandidateCollection({
    task, now: new Date("2026-08-14T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus(input) { calls.push(["preflight", input]); return { status: "READY", ready: true }; },
      async extractCandidateDetail(input) { calls.push(["extract", input]); return detailRecord(); },
    },
    repository: {
      async sourceExists(id) { calls.push(["source", id]); return true; },
      async persist(input) { calls.push(["persist", input]); return { candidateId: "fixture-cand", rawRecordId: "fixture-raw" }; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.persisted, 1);
  assert.deepEqual(calls.map(([name]) => name), ["source", "preflight", "extract", "persist"]);
  assert.equal(calls[1][1].contractId, "liebide-candidate-detail-v1");
  assert.equal(calls[1][1].expectedCandidateId, task.externalId);
  assert.equal(calls[2][1].expectedTitle, task.expectedTitle);
  const persistInput = calls[3][1];
  assert.equal(persistInput.candidate.displayName, "示例候选人甲");
  assert.equal(persistInput.profile.currentTitle, "数据工程师");
  assert.equal(persistInput.profile.currentCompany, "虚构科技");
  assert.equal(persistInput.record.contentHash, "a".repeat(64));
});

test("未登录等非导航状态和 ID 不一致禁止持久化", async () => {
  let extracted = false;
  let persisted = false;
  const blocked = await runBrowserCandidateCollection({
    task, now: new Date("2026-08-14T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus() { return { status: "AUTH_REQUIRED", ready: false }; },
      async extractCandidateDetail() { extracted = true; },
    },
    repository: { async sourceExists() { return true; }, async persist() { persisted = true; } },
  });
  assert.equal(blocked.errorCode, "BROWSER_AUTH_REQUIRED");
  assert.equal(extracted, false);
  assert.equal(persisted, false);

  const mismatched = await runBrowserCandidateCollection({
    task, now: new Date("2026-08-14T09:00:00.000Z"),
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async extractCandidateDetail() { return detailRecord({ candidateId: "other-cand" }); },
    },
    repository: { async sourceExists() { return true; }, async persist() { persisted = true; } },
  });
  assert.equal(mismatched.errorCode, "BROWSER_ENTITY_MISMATCH");
  assert.equal(persisted, false);
});

test("差分发现跳过已入库未变候选人、只采集新增，凑满目标即停", async () => {
  const calls = [];
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-talent-pool-list-v1", batchSize: 1, maxPages: 20,
  };
  const result = await runBrowserCandidateBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { calls.push(["preflight"]); return { status: "READY", ready: true }; },
      async discoverTalentPool(input) { calls.push(["discover", input]); return {
        items: [
          { candidateId: "fixture-cand-001", title: "数据工程师", realName: "示例候选人甲", pageNumber: 1, position: 1 },
          { candidateId: "fixture-cand-002", title: "算法工程师", realName: "示例候选人乙", pageNumber: 1, position: 2 },
        ],
        nextPage: 2, nextOffset: 0, stopReason: "batch_size", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { calls.push(["source"]); return true; },
      async findKnownCandidates() { calls.push(["known"]); return [{ candidateId: "fixture-cand-001", title: "数据工程师" }]; },
      async persistDiscovery(input) {
        calls.push(["persist", input]);
        return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 1);
  assert.equal(result.stats.skippedKnown, 1);
  assert.equal(result.stats.stopReason, "target_reached");
  const persisted = calls.find(([name]) => name === "persist")[1];
  assert.deepEqual(persisted.discovery.items.map((i) => i.candidateId), ["fixture-cand-002"]);
  assert.equal(persisted.detailContractId, "liebide-candidate-detail-v1");
});

test("凑不满目标时按数字断点向后翻页，已入库但标题变化的候选人按变更重新采集", async () => {
  const discoverResponses = [
    {
      items: [{ candidateId: "fixture-cand-001", title: "数据工程师", realName: "示例候选人甲", pageNumber: 1, position: 1 }],
      nextPage: 2, nextOffset: 0, stopReason: "batch_size", pagesVisited: 1,
    },
    {
      items: [
        { candidateId: "fixture-cand-002", title: "算法工程师", realName: "示例候选人乙", pageNumber: 2, position: 1 },
        { candidateId: "fixture-cand-003", title: "数据开发", realName: "示例候选人丙", pageNumber: 2, position: 2 },
      ],
      nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
    },
  ];
  let responseIndex = 0;
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-talent-pool-list-v1", batchSize: 2, maxPages: 20,
  };
  const result = await runBrowserCandidateBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async discoverTalentPool() { return discoverResponses[responseIndex++]; },
    },
    repository: {
      async sourceExists() { return true; },
      async findKnownCandidates() { return [{ candidateId: "fixture-cand-001", title: "数据工程师" }]; },
      async persistDiscovery(input) {
        return { createdItems: input.discovery.items.length, enqueuedDetails: input.discovery.items.length };
      },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 2);
  assert.equal(result.stats.pages, 2);
});

test("全部已知且标题未变时本批采集 0 条并正常结束", async () => {
  const batchTask = {
    batchId: "22222222-2222-4222-8222-222222222222",
    sourceConnectionId: task.sourceConnectionId,
    userId: task.userId, deviceId: task.deviceId,
    contractId: "liebide-talent-pool-list-v1", batchSize: 5, maxPages: 20,
  };
  const result = await runBrowserCandidateBatchDiscovery({
    task: batchTask,
    relayClient: {
      async getConnectionStatus() { return { status: "READY", ready: true }; },
      async discoverTalentPool() { return {
        items: [{ candidateId: "fixture-cand-001", title: "数据工程师", realName: "示例候选人甲", pageNumber: 1, position: 1 }],
        nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
      }; },
    },
    repository: {
      async sourceExists() { return true; },
      async findKnownCandidates() { return [{ candidateId: "fixture-cand-001", title: "数据工程师" }]; },
      async persistDiscovery() { return { createdItems: 0, enqueuedDetails: 0 }; },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stats.newOrChanged, 0);
  assert.equal(result.stats.skippedKnown, 1);
});

test("候选人详情回执 → 实体映射：真实姓名进 candidate、近期工作进 profile", () => {
  const { candidate, profile } = mapCandidateRecordToEntities(detailRecord());
  assert.equal(candidate.externalId, "fixture-cand-001");
  assert.equal(candidate.displayName, "示例候选人甲");
  assert.equal(profile.currentTitle, "数据工程师");
  assert.equal(profile.currentCompany, "虚构科技");
  assert.equal(profile.experienceYears, 8);
  assert.equal(profile.location, "北京");
  assert.equal(profile.education, "本科");
  assert.equal(profile.school, "虚构大学");
  assert.equal(profile.major, "计算机");
  assert.equal(profile.industry, null);
  assert.equal("mobile" in candidate, false);
  assert.equal("content" in profile, false);
});
