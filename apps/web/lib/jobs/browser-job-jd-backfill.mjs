import { randomUUID } from "node:crypto";

import {
  BrowserCollectionContractError,
  LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  LIEBIDE_PLATFORM_ORIGIN,
} from "../adapters/csdn-browser/browser-collection-contract.mjs";
import { BrowserRelayError } from "../adapters/csdn-browser/relay-client.mjs";
import { createAsyncTaskRepository } from "./async-task-repository.mjs";
import { getOrCreateSourceConnection } from "./job-sync-repository.mjs";

export const BROWSER_JOB_JD_BACKFILL_TASK_KIND = "browser_job_jd_backfill";
export const BROWSER_JOB_JD_BACKFILL_SYNC_TYPE = "browser_job_jd_backfill";
/** 每轮最多入队的回填职位数（可操作缺 JD 通常有限；上限防异常扩散）。 */
export const DEFAULT_BACKFILL_LIMIT = 50;

const TASK_KEYS = new Set([
  "sourceConnectionId",
  "userId",
  "deviceId",
  "contractId",
  "externalId",
  "jobId",
  "expectedTitle",
]);

export class BrowserJobJdBackfillError extends Error {
  constructor(message, code = "BROWSER_JOB_JD_BACKFILL_INVALID") {
    super(message);
    this.name = "BrowserJobJdBackfillError";
    this.code = code;
  }
}

/**
 * 解析回填任务载荷：白名单字段；contractId 固定为 liebide-job-detail-v2
 * （空 JD 需 v2 的 jobDescriptionMissing 信号区分「供应方无数据」与契约漂移）。
 */
export function parseBrowserJobJdBackfillTaskPayload(input) {
  if (!isPlainObject(input)) throw new BrowserJobJdBackfillError("task payload must be an object");
  for (const key of Object.keys(input)) {
    if (!TASK_KEYS.has(key)) throw new BrowserJobJdBackfillError(`task payload field ${key} is forbidden`);
  }
  if (input.contractId !== LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID) {
    throw new BrowserJobJdBackfillError("contractId is unsupported");
  }
  const output = {
    sourceConnectionId: requireUuid(input.sourceConnectionId, "sourceConnectionId"),
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    externalId: requireIdentifier(input.externalId, "externalId"),
    jobId: requireUuid(input.jobId, "jobId"),
  };
  if (input.expectedTitle !== undefined) output.expectedTitle = requireTitle(input.expectedTitle, "expectedTitle");
  return output;
}

/**
 * 单个职位 JD 回填：预检（浏览器就绪）→ liebide-job-detail-v2 详情提取 → externalId 校验 →
 * 按 jobDescriptionMissing 分叉 filled / no_provider_jd。
 *
 * - **只补 JD**：不经沉睡资格门禁（职位已由 MCP 入库，JD 是持久数据），不覆盖其他 MCP 字段。
 * - 错误映射：relay → 仅 BROWSER_RELAY_UNAVAILABLE 可重试（不写台账）；预检未就绪 → 非可重试、
 *   不写台账（浏览器未就绪不是「供应方无数据」，下次手动触发再试）；提取阶段契约/实体失败 →
 *   非可重试 + 写台账 failed（已尝试，防重复爬同一职位）。
 */
export async function runBrowserJobJdBackfill({ task: rawTask, relayClient, repository }) {
  let task;
  try {
    task = parseBrowserJobJdBackfillTaskPayload(rawTask);
  } catch (error) {
    return failed(error.code ?? "BROWSER_JOB_JD_BACKFILL_INVALID", false);
  }
  if (!(await repository.sourceExists(task.sourceConnectionId))) return failed("BROWSER_SOURCE_NOT_FOUND", false);

  const route = {
    userId: task.userId,
    deviceId: task.deviceId,
    expectedExternalId: task.externalId,
    ...(task.expectedTitle ? { expectedTitle: task.expectedTitle } : {}),
  };

  // 预检：READY 或确定性导航（WRONG_ENTITY + session 匹配 + 授权域名 + 已认证）。
  try {
    const status = await relayClient.getConnectionStatus({
      ...route,
      contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
    });
    const ready = status.ready && status.status === "READY";
    const mayNavigateDeterministically =
      status.status === "WRONG_ENTITY" &&
      status.sessionMatched === true &&
      status.origin === LIEBIDE_PLATFORM_ORIGIN &&
      status.authState === "authenticated";
    if (!ready && !mayNavigateDeterministically) {
      return failed(browserStatusErrorCode(status.status), false, { preflight: 1 });
    }
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError) return failed(error.code, false);
    return failed("BROWSER_JOB_JD_BACKFILL_PREFLIGHT_ERROR", false);
  }

  try {
    const record = await relayClient.extractJobDetail(route, { contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID });
    if (record.externalId !== task.externalId) {
      throw new BrowserJobJdBackfillError("browser entity mismatch", "BROWSER_ENTITY_MISMATCH");
    }
    if (record.jobDescriptionMissing) {
      const saved = await repository.persistNoProviderJd({
        sourceConnectionId: task.sourceConnectionId,
        contractId: task.contractId,
        jobId: task.jobId,
        externalId: task.externalId,
        record,
      });
      return {
        status: "succeeded",
        retryable: false,
        ...saved,
        stats: { preflight: 1, extracted: 1, filled: 0, noProviderJd: 1, persisted: 1 },
      };
    }
    const saved = await repository.persistFilled({
      sourceConnectionId: task.sourceConnectionId,
      contractId: task.contractId,
      jobId: task.jobId,
      externalId: task.externalId,
      record,
    });
    return {
      status: "succeeded",
      retryable: false,
      ...saved,
      stats: { preflight: 1, extracted: 1, filled: 1, noProviderJd: 0, persisted: 1 },
    };
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError || error instanceof BrowserJobJdBackfillError) {
      const errorCode = error.code ?? "BROWSER_COLLECTION_CONTRACT_INVALID";
      try {
        await repository.persistFailed({
          sourceConnectionId: task.sourceConnectionId,
          contractId: task.contractId,
          jobId: task.jobId,
          externalId: task.externalId,
          errorCode,
        });
      } catch {
        // 台账写入失败不掩盖原始错误。
      }
      return failed(errorCode, false);
    }
    return failed("BROWSER_JOB_JD_BACKFILL_INTERNAL_ERROR", false);
  }
}

/**
 * DB 驱动入队：选「可操作 + active + 缺 JD + 台账未尝试」职位（沉睡优先），
 * 逐个经 target-idle 守卫入队 `browser_job_jd_backfill` 任务。
 * 返回 { scanned, enqueued, skipped, sourceId }。
 */
export async function enqueueBrowserJobJdBackfillTasks({
  sql,
  source,
  userId,
  deviceId,
  limit = DEFAULT_BACKFILL_LIMIT,
}) {
  const sourceId = await getOrCreateSourceConnection(sql, source);
  const rows = await sql`
    select id as "jobId", external_id as "externalId", title
    from jobs
    where source_connection_id = ${sourceId}
      and status = 'active'
      and operability_status = 'actionable'
      and (job_description is null or btrim(job_description) = '')
      and not exists (select 1 from job_jd_backfills b where b.job_id = jobs.id)
    order by days_without_recommendation desc nulls last
    limit ${limit}
  `;
  const taskRepo = createAsyncTaskRepository(sql);
  // 幂等键带每次触发的随机后缀：跨触发重复点击不撞 async_tasks_idempotency_key_unique
  // （dedup 交给 enqueueBrowserJobTaskIfTargetIdle 的 pending/running 守卫），
  // 避免「上次任务已 succeeded/失败但未落台账」时二次入队报 23505。
  const triggerId = randomUUID();
  let enqueued = 0;
  const skipped = [];
  for (const row of rows) {
    const payload = {
      sourceConnectionId: sourceId,
      userId,
      deviceId,
      contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
      externalId: row.externalId,
      jobId: row.jobId,
      ...(row.title ? { expectedTitle: row.title } : {}),
    };
    const taskId = await taskRepo.enqueueBrowserJobTaskIfTargetIdle({
      kind: BROWSER_JOB_JD_BACKFILL_TASK_KIND,
      idempotencyKey: `browser-job-jd-backfill:${sourceId}:${triggerId}:${row.externalId}`,
      payload,
      scheduledAt: new Date(),
    });
    if (taskId) enqueued += 1;
    else skipped.push(row.externalId);
  }
  return { scanned: rows.length, enqueued, skipped, sourceId };
}

function failed(errorCode, retryable, stats = null) {
  return { status: "failed", errorCode, retryable, stats };
}

/** 连接预检状态转失败码：状态值可能已带 `BROWSER_` 前缀，统一只补一次，避免 `BROWSER_BROWSER_` 双前缀。 */
function browserStatusErrorCode(status) {
  return status.startsWith("BROWSER_") ? status : `BROWSER_${status}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new BrowserJobJdBackfillError(`${field} is required`);
  return value.trim();
}

function requireIdentifier(value, field) {
  const result = requireString(value, field);
  if (result.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(result)) throw new BrowserJobJdBackfillError(`${field} is invalid`);
  return result;
}

function requireTitle(value, field) {
  const result = requireString(value, field);
  if (result.length > 500) throw new BrowserJobJdBackfillError(`${field} is too long`);
  return result;
}

function requireUuid(value, field) {
  const result = requireString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new BrowserJobJdBackfillError(`${field} must be a UUID`);
  return result;
}
