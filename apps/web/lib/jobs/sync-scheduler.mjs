import { McpDiscoveryError } from "../adapters/mcp-discovery.mjs";
import { BrowserRelayError, createCsdnBrowserRelayClient } from "../adapters/csdn-browser/relay-client.mjs";
import { createAuthRepository } from "../identity/auth-repository.mjs";
import { createAsyncTaskRepository } from "./async-task-repository.mjs";
import { runBrowserJobBatchDiscovery, runBrowserJobCollection } from "./browser-job-collection.mjs";
import { createBrowserJobCollectionRepository } from "./browser-job-collection-repository.mjs";
import { createBrowserJobBatchRepository, updateBrowserCollectionBatchDiscoveryOutcome, updateBrowserCollectionItemOutcome } from "./browser-job-batch-repository.mjs";
import {
  JOBS_GET_TOOL,
  runJobDetailsSync,
} from "./job-details-sync.mjs";
import { runMatchSync } from "./match-sync.mjs";
import {
  createDefaultCallTool,
  runUnderServedSync,
} from "./under-served-sync.mjs";

/** 默认同步周期：每 6 小时一个幂等槽位。 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
/** 任务看门狗阈值：running 任务超过该时长视为崩溃残留，回收为 failed（防去重守卫被永久锁死）。 */
const DEFAULT_STALE_TASK_MS = 30 * 60 * 1000;
const TASK_KIND_SYNC = "under_served_sync";
const TASK_KIND_JOB_DETAILS = "job_details_sync";
const TASK_KIND_MATCH = "match_candidates_sync";
export const TASK_KIND_BROWSER_JOB_COLLECT = "browser_job_collect";
export const TASK_KIND_BROWSER_JOB_BATCH_DISCOVER = "browser_job_batch_discover";

/** 周期槽位键：now 所在的 interval 序号（纯函数，可单测）。 */
export function syncPeriodKey(now, intervalMs) {
  return Math.floor(now.getTime() / intervalMs);
}

/** 周期同步任务的幂等键（provider + 周期槽位）。 */
export function buildSyncIdempotencyKey(provider, periodKey) {
  return `under-served-sync:${provider}:${periodKey}`;
}

/** 指数退避毫秒数（attempts 为本次尝试序号，从 1 起），封顶 maxMs。 */
export function nextRetryDelayMs(
  attempts,
  baseMs = RETRY_BASE_MS,
  maxMs = RETRY_MAX_MS,
) {
  return Math.min(baseMs * 2 ** (attempts - 1), maxMs);
}

/**
 * 任务结果判定（纯函数，可单测）：
 * - succeeded → succeeded；
 * - 非 retryable（业务/契约/配置错误）→ failed 不重试；
 * - retryable 且 attempts < maxAttempts → retry；
 * - retryable 且 attempts >= maxAttempts → dead。
 * `attempts` 为认领后的计数（已含本次）。
 */
export function decideTaskOutcome({ status, retryable, attempts, maxAttempts }) {
  if (status === "succeeded") return "succeeded";
  if (!retryable) return "failed";
  if (attempts < maxAttempts) return "retry";
  return "dead";
}

function resolveSyncSource(env) {
  return {
    provider: env.SYNC_SOURCE_PROVIDER ?? "csdn-mcp",
    environment:
      env.APP_ENV === "production" || env.APP_ENV === "test"
        ? env.APP_ENV
        : "development",
    displayName: env.SYNC_SOURCE_DISPLAY_NAME ?? "CSDN Enterprise MCP",
  };
}

/**
 * 入队当前周期的同步任务（幂等）：同周期重复入队为 no-op，返回既有任务 id。
 */
export async function enqueueDueSyncTasks(
  sql,
  { source, now, intervalMs = DEFAULT_INTERVAL_MS },
) {
  const taskRepo = createAsyncTaskRepository(sql);
  const periodKey = syncPeriodKey(now, intervalMs);
  const idempotencyKey = buildSyncIdempotencyKey(source.provider, periodKey);
  const taskId = await taskRepo.enqueueTask({
    kind: TASK_KIND_SYNC,
    idempotencyKey,
    payload: { source },
    scheduledAt: now,
  });
  if (taskId) return { enqueued: true, taskId, idempotencyKey };
  const existing = await sql`
    select id from async_tasks where idempotency_key = ${idempotencyKey}
  `;
  return { enqueued: false, taskId: existing[0]?.id ?? null, idempotencyKey };
}

/**
 * 入队当前周期的 JD 详情补全任务（幂等）：同周期重复入队为 no-op，返回既有任务 id。
 * 与 under_served 同步使用不同幂等键，可独立调度/重试/处置。
 */
export async function enqueueJobDetailSyncTasks(
  sql,
  { source, now, intervalMs = DEFAULT_INTERVAL_MS },
) {
  const taskRepo = createAsyncTaskRepository(sql);
  const periodKey = syncPeriodKey(now, intervalMs);
  const idempotencyKey = `job-details-sync:${source.provider}:${periodKey}`;
  const taskId = await taskRepo.enqueueTask({
    kind: TASK_KIND_JOB_DETAILS,
    idempotencyKey,
    payload: { source },
    scheduledAt: now,
  });
  if (taskId) return { enqueuedDetails: true, taskId, idempotencyKey };
  const existing = await sql`
    select id from async_tasks where idempotency_key = ${idempotencyKey}
  `;
  return {
    enqueuedDetails: false,
    taskId: existing[0]?.id ?? null,
    idempotencyKey,
  };
}

/** 执行同步任务：配置从 env 解析（加密/MCP 可注入 mcp 用假客户端测试）。 */
async function runSyncForTask(sql, { env, task, mcp, browserRelay, now }) {
  try {
    const source = task.payload?.source ?? resolveSyncSource(env);
    if (task.kind === TASK_KIND_BROWSER_JOB_COLLECT) {
      const encryption = {
        key: env.APP_ENCRYPTION_KEY,
        keyVersion: env.APP_ENCRYPTION_KEY_VERSION,
      };
      if (!encryption.key || !encryption.keyVersion) {
        return { status: "failed", errorCode: "ENCRYPTION_CONFIG_REQUIRED", retryable: false, stats: null };
      }
      const relayClient = browserRelay ?? createCsdnBrowserRelayClient({
        requestUrl: env.BROWSER_RELAY_URL,
        token: env.BROWSER_RELAY_TOKEN,
      });
      return runBrowserJobCollection({
        task: task.payload,
        now,
        relayClient,
        repository: createBrowserJobCollectionRepository(sql, { encryption }),
      });
    }
    if (task.kind === TASK_KIND_BROWSER_JOB_BATCH_DISCOVER) {
      const relayClient = browserRelay ?? createCsdnBrowserRelayClient({
        requestUrl: env.BROWSER_RELAY_URL,
        token: env.BROWSER_RELAY_TOKEN,
      });
      return runBrowserJobBatchDiscovery({
        task: task.payload,
        relayClient,
        repository: createBrowserJobBatchRepository(sql),
      });
    }
    // job_details 同步独立运行（白名单收紧到 [wb.jobs.get]）：其失败不毒化 dormant 同步。
    if (task.kind === TASK_KIND_JOB_DETAILS) {
      const callTool =
        mcp?.callTool ?? createDefaultCallTool({ env, allowedTools: [JOBS_GET_TOOL] });
      return await runJobDetailsSync({ sql, source, mcp: { callTool } });
    }
    // 匹配任务流（M2）：按需触发（POST /api/match-tasks 入队），对选定可操作职位跑本地评分
    // （外部对照 mcp 可选——提供时把 match_candidates 结果写入 external_*，不作为权威分）。
    if (task.kind === TASK_KIND_MATCH) {
      const jobIds = Array.isArray(task.payload?.jobIds)
        ? task.payload.jobIds
        : [];
      if (mcp?.callTool) {
        return await runMatchSync({ sql, source, jobIds, mcp });
      }
      return await runMatchSync({ sql, source, jobIds });
    }
    const encryption = {
      key: env.APP_ENCRYPTION_KEY,
      keyVersion: env.APP_ENCRYPTION_KEY_VERSION,
    };
    if (!encryption.key || !encryption.keyVersion) {
      return {
        status: "failed",
        errorCode: "ENCRYPTION_CONFIG_REQUIRED",
        retryable: false,
        stats: null,
      };
    }
    const callTool = mcp?.callTool ?? createDefaultCallTool({ env });
    return await runUnderServedSync({ sql, encryption, source, mcp: { callTool } });
  } catch (error) {
    // 配置解析（MCP 凭证缺失等）等在 runUnderServedSync 抛出前的错误：机器可读，不泄露原始错误。
    return {
      status: "failed",
      errorCode: classifyTaskError(error),
      retryable: false,
      stats: null,
    };
  }
}

function classifyTaskError(error) {
  if (
    error instanceof McpDiscoveryError &&
    typeof error.code === "string" &&
    error.code
  ) {
    return error.code;
  }
  if (error instanceof BrowserRelayError) return error.code;
  return "SYNC_INTERNAL_ERROR";
}

/** 写 `sync.run` 系统审计（metadata 仅计数/机器码；失败吞掉不阻断任务流转）。 */
async function writeSyncAudit(repo, { outcome, decision, requestId }) {
  const metadata = {};
  if (outcome.stats) {
    for (const key of [
      "pages",
      "seen",
      "eligible",
      "skipped",
      "operable",
      "inoperableSeen",
      "persisted",
      "closedStale",
      "maxPagesReached",
      "queried",
      "detailsMatched",
      "detailsMissing",
      "jobsQueried",
      "candidatesScored",
      "matchesStored",
      "hardFiltered",
      "failed",
      "preflight",
      "extracted",
      "discovered",
      "enqueued",
    ]) {
      if (key in outcome.stats) metadata[key] = outcome.stats[key];
    }
  }
  if (outcome.errorCode) metadata.errorCode = outcome.errorCode;
  try {
    await repo.insertAudit({
      actorType: "system",
      actorId: null,
      action: "sync.run",
      resourceType: "sync_run",
      resourceId: outcome.syncRunId ?? null,
      result: decision === "succeeded" ? "success" : "failure",
      requestId,
      metadata,
    });
  } catch {
    // 审计写入失败不阻断任务状态流转
  }
}

/**
 * 处理到期任务：先回收崩溃残留的 running 任务（任务看门狗，防止去重守卫被永久锁死），
 * 再认领 → 跑同步 → 写 sync.run 审计 → succeeded/retry/failed/dead。
 */
export async function processDueTasks(
  sql,
  {
    env,
    now,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    staleTaskMs = DEFAULT_STALE_TASK_MS,
    mcp,
    browserRelay,
  },
) {
  const taskRepo = createAsyncTaskRepository(sql);
  const authRepo = createAuthRepository(sql);
  // 任务看门狗：running 超时（进程崩溃残留）→ failed + TASK_STALE_TIMEOUT，
  // 释放手动同步去重守卫（否则卡死任务会永久拦截新入队）。
  const staleReclaimed = await taskRepo.failStaleRunningTasks({
    staleBefore: new Date(now.getTime() - staleTaskMs),
  });
  const tasks = await taskRepo.claimDueTasks({ limit: 10, now });
  const counts = {
    staleReclaimed,
    claimed: tasks.length,
    succeeded: 0,
    retried: 0,
    failed: 0,
    dead: 0,
  };

  for (const task of tasks) {
    const outcome = await runSyncForTask(sql, { env, task, mcp, browserRelay, now });
    const decision = decideTaskOutcome({
      status: outcome.status,
      retryable: outcome.retryable,
      attempts: task.attempts,
      maxAttempts,
    });
    await updateBrowserCollectionItemOutcome(sql, task.payload, outcome, decision, now);
    await updateBrowserCollectionBatchDiscoveryOutcome(sql, task.payload, outcome, decision, now);
    await writeSyncAudit(authRepo, {
      outcome,
      decision,
      requestId: task.id,
    });

    if (decision === "succeeded") {
      await taskRepo.finishTask({
        id: task.id,
        status: "succeeded",
        finishedAt: now,
      });
      counts.succeeded += 1;
    } else if (decision === "retry") {
      const delay = nextRetryDelayMs(task.attempts);
      await taskRepo.markPendingForRetry({
        id: task.id,
        nextAttemptAt: new Date(now.getTime() + delay),
        errorCode: outcome.errorCode,
      });
      counts.retried += 1;
    } else if (decision === "dead") {
      await taskRepo.finishTask({
        id: task.id,
        status: "dead",
        errorCode: outcome.errorCode,
        finishedAt: now,
      });
      counts.dead += 1;
    } else {
      await taskRepo.finishTask({
        id: task.id,
        status: "failed",
        errorCode: outcome.errorCode,
        finishedAt: now,
      });
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * 调度 tick：先入队当前周期同步任务（幂等），再处理到期任务。
 * Worker `scheduled` 处理器与测试（假 MCP）共用；`now`/`intervalMs`/`maxAttempts` 可注入。
 */
export async function runScheduledTick({
  env,
  sql,
  now = new Date(),
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  staleTaskMs = DEFAULT_STALE_TASK_MS,
  mcp,
  browserRelay,
}) {
  const source = resolveSyncSource(env);
  const enqueued = await enqueueDueSyncTasks(sql, { source, now, intervalMs });
  const enqueuedDetails = await enqueueJobDetailSyncTasks(sql, {
    source,
    now,
    intervalMs,
  });
  const summary = await processDueTasks(sql, {
    env,
    now,
    maxAttempts,
    staleTaskMs,
    mcp,
    browserRelay,
  });
  // `taskId`/`idempotencyKey` 保持 under_served 主键（既有消费方兼容）；
  // job_details 任务用独立前缀键，避免 spread 覆盖。
  return {
    ...enqueued,
    detailsEnqueued: enqueuedDetails.enqueuedDetails,
    detailsTaskId: enqueuedDetails.taskId,
    detailsIdempotencyKey: enqueuedDetails.idempotencyKey,
    ...summary,
  };
}
