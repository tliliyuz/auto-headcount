import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCollectionContractError,
  LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  LIEBIDE_PLATFORM_ORIGIN,
} from "../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import { BrowserRelayError } from "../lib/adapters/csdn-browser/relay-client.mjs";
import {
  BrowserJobJdBackfillError,
  BROWSER_JOB_JD_BACKFILL_TASK_KIND,
  parseBrowserJobJdBackfillTaskPayload,
  runBrowserJobJdBackfill,
} from "../lib/jobs/browser-job-jd-backfill.mjs";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const TASK = {
  sourceConnectionId: SOURCE_ID,
  userId: "ops_fixture",
  deviceId: "device-fixture-001",
  contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  externalId: "job-ext-001",
  jobId: JOB_ID,
  expectedTitle: "示例数据工程师",
};

/** 非沉睡回执（有效推荐数 5）：证明回填不经沉睡资格门禁。 */
const RECORD_FILLED = {
  contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  contractVersion: 2,
  sourceOrigin: LIEBIDE_PLATFORM_ORIGIN,
  capturedAt: "2026-08-16T09:00:00.000Z",
  contentHash: "c".repeat(64),
  externalId: "job-ext-001",
  title: "示例数据工程师",
  status: "active",
  city: "上海",
  salaryMin: 20000,
  salaryMax: 35000,
  jobDescription: "负责虚构数据平台建设与数据管道治理。",
  jobDescriptionMissing: false,
  publishedAt: "2026-08-01T00:00:00.000Z",
  validRecommendationCount: 5,
};

const RECORD_MISSING = {
  ...RECORD_FILLED,
  jobDescription: null,
  jobDescriptionMissing: true,
};

function createFakeRelay({ status, record, extractError } = {}) {
  return {
    async getConnectionStatus() {
      return status ?? {
        status: "READY", ready: true, sessionMatched: true,
        origin: LIEBIDE_PLATFORM_ORIGIN, authState: "authenticated",
      };
    },
    async extractJobDetail() {
      if (extractError) throw extractError;
      return record ?? RECORD_FILLED;
    },
  };
}

function createFakeRepository({ sourceExists = true } = {}) {
  const calls = { persistFilled: [], persistNoProviderJd: [], persistFailed: [] };
  const repository = {
    calls,
    async sourceExists() { return sourceExists; },
    async persistFilled(args) { calls.persistFilled.push(args); return { syncRunId: "sr", rawRecordId: "rr", ledgerId: "ld", matched: 1 }; },
    async persistNoProviderJd(args) { calls.persistNoProviderJd.push(args); return { syncRunId: "sr", rawRecordId: "rr", ledgerId: "ld", matched: 0 }; },
    async persistFailed(args) { calls.persistFailed.push(args); return { syncRunId: "sr", ledgerId: "ld" }; },
  };
  return repository;
}

test("任务载荷固定 v2 契约并拒绝未知字段/非法 UUID", () => {
  assert.deepEqual(parseBrowserJobJdBackfillTaskPayload(TASK), TASK);
  assert.throws(() => parseBrowserJobJdBackfillTaskPayload({ ...TASK, contractId: "liebide-job-detail-v1" }), BrowserJobJdBackfillError);
  assert.throws(() => parseBrowserJobJdBackfillTaskPayload({ ...TASK, expression: "document.cookie" }), BrowserJobJdBackfillError);
  assert.throws(() => parseBrowserJobJdBackfillTaskPayload({ ...TASK, jobId: "not-a-uuid" }), BrowserJobJdBackfillError);
  assert.equal(BROWSER_JOB_JD_BACKFILL_TASK_KIND, "browser_job_jd_backfill");
});

test("抓到 JD → filled：更新 job_description、不经沉睡资格门禁", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({ task: TASK, relayClient: createFakeRelay(), repository });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stats.filled, 1);
  assert.equal(outcome.stats.noProviderJd, 0);
  assert.equal(repository.calls.persistFilled.length, 1);
  assert.equal(repository.calls.persistFilled[0].jobId, JOB_ID);
  assert.equal(repository.calls.persistFilled[0].record.jobDescription, RECORD_FILLED.jobDescription);
  // 非沉睡回执（rec=5）也回填 → 无资格门禁
  assert.equal(repository.calls.persistNoProviderJd.length, 0);
});

test("供应方无 JD（jobDescriptionMissing）→ no_provider_jd，不更新 job_description", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({ task: TASK, relayClient: createFakeRelay({ record: RECORD_MISSING }), repository });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stats.noProviderJd, 1);
  assert.equal(outcome.stats.filled, 0);
  assert.equal(repository.calls.persistNoProviderJd.length, 1);
  assert.equal(repository.calls.persistNoProviderJd[0].record.jobDescriptionMissing, true);
  assert.equal(repository.calls.persistFilled.length, 0);
});

test("浏览器未就绪 → 失败不写台账（下次手动触发再试）", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({
    task: TASK,
    relayClient: createFakeRelay({
      status: { status: "PAGE_NOT_REGISTERED", ready: false, sessionMatched: false, origin: null, authState: "anonymous" },
    }),
    repository,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "BROWSER_PAGE_NOT_REGISTERED");
  assert.equal(outcome.retryable, false);
  assert.equal(repository.calls.persistFilled.length, 0);
  assert.equal(repository.calls.persistNoProviderJd.length, 0);
  assert.equal(repository.calls.persistFailed.length, 0, "预检未就绪不是供应方无数据，不写台账");
});

test("relay 瞬时故障 → 可重试、不写台账", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({
    task: TASK,
    relayClient: createFakeRelay({ extractError: new BrowserRelayError("bridge offline") }),
    repository,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "BROWSER_RELAY_UNAVAILABLE");
  assert.equal(outcome.retryable, true);
  assert.equal(repository.calls.persistFailed.length, 0);
});

test("提取阶段契约失败 → 写台账 failed、非可重试", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({
    task: TASK,
    relayClient: createFakeRelay({ extractError: new BrowserCollectionContractError("record jobDescription must not be empty") }),
    repository,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "BROWSER_COLLECTION_CONTRACT_INVALID");
  assert.equal(outcome.retryable, false);
  assert.equal(repository.calls.persistFailed.length, 1);
  assert.equal(repository.calls.persistFailed[0].errorCode, "BROWSER_COLLECTION_CONTRACT_INVALID");
  assert.equal(repository.calls.persistFailed[0].jobId, JOB_ID);
});

test("实体不匹配 → 写台账 failed、非可重试", async () => {
  const repository = createFakeRepository();
  const outcome = await runBrowserJobJdBackfill({
    task: TASK,
    relayClient: createFakeRelay({ record: { ...RECORD_FILLED, externalId: "job-other" } }),
    repository,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "BROWSER_ENTITY_MISMATCH");
  assert.equal(outcome.retryable, false);
  assert.equal(repository.calls.persistFailed.length, 1);
  assert.equal(repository.calls.persistFailed[0].errorCode, "BROWSER_ENTITY_MISMATCH");
});

test("来源不存在 → BROWSER_SOURCE_NOT_FOUND", async () => {
  const repository = createFakeRepository({ sourceExists: false });
  const outcome = await runBrowserJobJdBackfill({ task: TASK, relayClient: createFakeRelay(), repository });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "BROWSER_SOURCE_NOT_FOUND");
});
