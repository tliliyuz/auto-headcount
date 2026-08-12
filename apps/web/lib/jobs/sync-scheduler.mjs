import { McpDiscoveryError } from "../adapters/mcp-discovery.mjs";
import { createAuthRepository } from "../identity/auth-repository.mjs";
import { createAsyncTaskRepository } from "./async-task-repository.mjs";
import {
  createDefaultCallTool,
  runUnderServedSync,
} from "./under-served-sync.mjs";

/** 默认同步周期：每 6 小时一个幂等槽位。 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const TASK_KIND_SYNC = "under_served_sync";

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

/** 执行同步任务：配置从 env 解析（加密/MCP 可注入 mcp 用假客户端测试）。 */
async function runSyncForTask(sql, { env, task, mcp }) {
  try {
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
    const source = task.payload?.source ?? resolveSyncSource(env);
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
      "persisted",
      "maxPagesReached",
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
 * 处理到期任务：认领 → 跑同步 → 写 sync.run 审计 → succeeded/retry/failed/dead。
 */
export async function processDueTasks(
  sql,
  { env, now, maxAttempts = DEFAULT_MAX_ATTEMPTS, mcp },
) {
  const taskRepo = createAsyncTaskRepository(sql);
  const authRepo = createAuthRepository(sql);
  const tasks = await taskRepo.claimDueTasks({ limit: 10, now });
  const counts = {
    claimed: tasks.length,
    succeeded: 0,
    retried: 0,
    failed: 0,
    dead: 0,
  };

  for (const task of tasks) {
    const outcome = await runSyncForTask(sql, { env, task, mcp });
    const decision = decideTaskOutcome({
      status: outcome.status,
      retryable: outcome.retryable,
      attempts: task.attempts,
      maxAttempts,
    });
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
  mcp,
}) {
  const source = resolveSyncSource(env);
  const enqueued = await enqueueDueSyncTasks(sql, { source, now, intervalMs });
  const summary = await processDueTasks(sql, { env, now, maxAttempts, mcp });
  return { ...enqueued, ...summary };
}
