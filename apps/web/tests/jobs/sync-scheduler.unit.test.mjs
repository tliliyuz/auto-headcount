import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJobRequirementsIdempotencyKey,
  buildMatchPipelineIdempotencyKey,
  buildProjectionFilterIdempotencyKey,
  buildSyncIdempotencyKey,
  decideTaskOutcome,
  nextRetryDelayMs,
  syncPeriodKey,
} from "../../lib/jobs/sync-scheduler.mjs";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

test("syncPeriodKey：同周期同键、跨周期不同键", () => {
  assert.equal(syncPeriodKey(new Date(0), SIX_HOURS_MS), 0);
  assert.equal(syncPeriodKey(new Date(SIX_HOURS_MS - 1), SIX_HOURS_MS), 0);
  assert.equal(syncPeriodKey(new Date(SIX_HOURS_MS), SIX_HOURS_MS), 1);
  assert.equal(
    syncPeriodKey(new Date(SIX_HOURS_MS * 2 + 5), SIX_HOURS_MS),
    2,
  );
});

test("buildJobRequirementsIdempotencyKey：provider + periodKey 拼接", () => {
  assert.equal(
    buildJobRequirementsIdempotencyKey("csdn-mcp", 12345),
    "job-requirements-extract:csdn-mcp:12345",
  );
});

test("buildSyncIdempotencyKey：provider + periodKey 拼接", () => {
  assert.equal(
    buildSyncIdempotencyKey("csdn-mcp", 12345),
    "under-served-sync:csdn-mcp:12345",
  );
});

test("自动匹配编排使用独立周期幂等键", () => {
  assert.equal(buildMatchPipelineIdempotencyKey(12345), "match-pipeline-v2:12345");
});

test("阶段一投影任务使用独立周期幂等键", () => {
  assert.equal(
    buildProjectionFilterIdempotencyKey(12345),
    "match-projection-filter:12345",
  );
});

test("decideTaskOutcome：成功/业务失败不重试/网络退避/超阈值 dead", () => {
  assert.equal(
    decideTaskOutcome({
      status: "succeeded",
      retryable: true,
      attempts: 1,
      maxAttempts: 3,
    }),
    "succeeded",
  );
  assert.equal(
    decideTaskOutcome({
      status: "failed",
      retryable: false,
      attempts: 1,
      maxAttempts: 3,
    }),
    "failed",
  );
  assert.equal(
    decideTaskOutcome({
      status: "failed",
      retryable: true,
      attempts: 1,
      maxAttempts: 3,
    }),
    "retry",
  );
  assert.equal(
    decideTaskOutcome({
      status: "failed",
      retryable: true,
      attempts: 2,
      maxAttempts: 3,
    }),
    "retry",
  );
  assert.equal(
    decideTaskOutcome({
      status: "failed",
      retryable: true,
      attempts: 3,
      maxAttempts: 3,
    }),
    "dead",
  );
  assert.equal(
    decideTaskOutcome({
      status: "failed",
      retryable: true,
      attempts: 4,
      maxAttempts: 3,
    }),
    "dead",
  );
});

test("nextRetryDelayMs：指数退避并封顶", () => {
  assert.equal(nextRetryDelayMs(1, 60_000, 3_600_000), 60_000);
  assert.equal(nextRetryDelayMs(2, 60_000, 3_600_000), 120_000);
  assert.equal(nextRetryDelayMs(3, 60_000, 3_600_000), 240_000);
  // 封顶
  assert.equal(nextRetryDelayMs(10, 60_000, 3_600_000), 3_600_000);
});
