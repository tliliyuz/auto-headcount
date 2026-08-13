import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../adapters/mcp-discovery.mjs";
import {
  McpContractError,
  parseJobsGetResult,
} from "../adapters/mcp-under-served-contract.mjs";
import {
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  startSyncRun,
  updateJobDescriptions,
} from "./job-sync-repository.mjs";

export const JOBS_GET_TOOL = "wb.jobs.get";
export const JOB_DETAILS_SYNC_TYPE = "job_details_jobs";
/** 每轮最多补全的 JD 条数（可操作∩沉睡通常很小；上限防异常扩散）。 */
const DEFAULT_JD_BATCH = 50;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * 独立 `job_details_jobs` 同步：补全「可操作∩沉睡」职位的 `job_description`。
 *
 * - **DB 驱动 + `wb.jobs.get`**（fix4，2026-08-13 受控验证：get 对沉睡职位广泛可用，返回 JD）：
 *   查询本地 `operability_status='actionable'` 且 7–30 天、缺 JD 的职位，逐个调 `wb.jobs.get(job_id)`
 *   补全——**只对交集职位调用**，不给 771 个不可操作职位逐个补 JD。
 * - 独立于 under_served 同步运行：`wb.jobs.get` 的权限边界/瞬时失败不会毒化已成功的
 *   dormant 同步；单个职位 get 失败（1003/瞬时）仅计入 `failed` 并跳过，不中断整轮。
 * - 不做 raw_records 原始快照（JD 属规范化字段补全，非新实体）；不 INSERT 职位行
 *   （职位行来源为 under_served 同步）。
 * - 成功 `finishSyncRun`；失败仅把机器可读 `error_code` 写入 `sync_runs`。
 *
 * `mcp.callTool` 可注入（测试用假客户端）；缺省使用真实适配器且白名单收紧为 `[JOBS_GET_TOOL]`。
 */
export async function runJobDetailsSync({
  sql,
  source,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
  mcp,
}) {
  const callTool = mcp?.callTool ?? createJobDetailsCallTool();
  const sourceId = await getOrCreateSourceConnection(sql, source);
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, JOB_DETAILS_SYNC_TYPE);
  const stats = { queried: 0, detailsMatched: 0, detailsMissing: 0, failed: 0 };

  try {
    // 只补「可操作∩沉睡」且缺 JD 的职位（fix4：不给不可操作职位逐个补 JD）。
    const missing = await sql`
      select external_id as "externalId"
      from jobs
      where source_connection_id = ${sourceId}
        and status = 'active'
        and days_without_recommendation between 7 and 30
        and operability_status = 'actionable'
        and job_description is null
      order by created_at
      limit ${DEFAULT_JD_BATCH}
    `;
    stats.queried = missing.length;

    const rows = [];
    for (const { externalId } of missing) {
      let jobDescription;
      try {
        const result = await callTool(JOBS_GET_TOOL, { job_id: externalId });
        ({ jobDescription } = parseJobsGetResult(result));
      } catch {
        stats.failed += 1; // 单职位失败跳过，不毒化整轮
        continue;
      }
      if (jobDescription === null || jobDescription === undefined) {
        stats.detailsMissing += 1; // 上游无 JD，保留现状（不抹既有值）
        continue;
      }
      rows.push({ externalId, jobDescription });
    }

    if (rows.length > 0) {
      const { matched } = await updateJobDescriptions(sql, { sourceId, rows });
      stats.detailsMatched = matched;
    }

    await finishSyncRun(sql, syncRunId, stats);
    return { status: "succeeded", syncRunId, sourceId, stats };
  } catch (error) {
    const errorCode = classifySyncError(error);
    const failureStats = { ...stats, errorCode };
    try {
      await failSyncRun(sql, syncRunId, errorCode, failureStats);
    } catch {
      // 记录失败本身出错时，不掩盖原始错误。
    }
    return {
      status: "failed",
      syncRunId,
      sourceId,
      errorCode,
      retryable: isRetryableError(error),
      stats: failureStats,
    };
  }
}

/**
 * 默认 MCP 调用工具（收紧白名单到 `[wb.jobs.get]`）：配置从 `env`（Worker 绑定）
 * 或缺省 process.env 解析。兼容旧调用 `createJobDetailsCallTool(actorId)`（字符串）。
 */
export function createJobDetailsCallTool(options = {}) {
  const { actorId, env } =
    typeof options === "string" ? { actorId: options } : options;
  const config = loadMcpDiscoveryConfig(env);
  return async (toolName, toolArguments) =>
    callMcpTool({
      ...config,
      actorId,
      toolName,
      arguments: toolArguments,
      allowedTools: [JOBS_GET_TOOL],
    });
}

function classifySyncError(error) {
  if (error instanceof McpDiscoveryError || error instanceof McpContractError) {
    return typeof error.code === "string" && error.code ? error.code : "MCP_ERROR";
  }
  return "SYNC_INTERNAL_ERROR";
}

/** 网络类错误（MCP 连接/限流/超时）标记 retryable，供任务表调度退避重试。 */
function isRetryableError(error) {
  return error instanceof McpDiscoveryError && error.retryable === true;
}
