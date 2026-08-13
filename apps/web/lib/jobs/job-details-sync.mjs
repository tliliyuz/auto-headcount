import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../adapters/mcp-discovery.mjs";
import {
  McpContractError,
  parseJobsListResult,
} from "../adapters/mcp-under-served-contract.mjs";
import {
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  startSyncRun,
  updateJobDescriptions,
} from "./job-sync-repository.mjs";

export const JOBS_LIST_TOOL = "wb.jobs.list";
export const JOB_DETAILS_SYNC_TYPE = "job_details_jobs";
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * 独立 `job_details_jobs` 同步：分页拉取 `wb.jobs.list`，按 external_id 补全
 * 该数据源下所有职位的 `job_description`（含历史遗留 NULL 回填）。
 *
 * - 独立于 under_served 同步运行：`wb.jobs.list` 的权限边界/瞬时失败不会
 *   毒化已成功的 dormant 同步，单独暴露错误码、单独重试（docs/04 §4）。
 * - 不做 raw_records 原始快照（JD 属规范化字段补全，非新实体）；不 INSERT
 *   职位行（`wb.jobs.list` 无沉睡口径，不作为职位行来源）。
 * - 成功 `finishSyncRun`；失败仅把机器可读 `error_code` 写入 `sync_runs`
 *   （`failSyncRun`），不落原始错误正文或任何凭证。
 *
 * `mcp.callTool` 可注入（测试用假客户端）；缺省使用真实适配器且白名单
 * 收紧为 `[JOBS_LIST_TOOL]`。
 */
export async function runJobDetailsSync({
  sql,
  source,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
  mcp,
}) {
  const callTool = mcp?.callTool ?? createJobDetailsCallTool(mcp?.actorId);
  const sourceId = await getOrCreateSourceConnection(sql, source);
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, JOB_DETAILS_SYNC_TYPE);
  const stats = {
    pages: 0,
    seen: 0,
    detailsSeen: 0,
    detailsMatched: 0,
    detailsMissing: 0,
  };

  try {
    const rows = [];
    let pageNumber = 1;
    let totalPages = 1;

    while (pageNumber <= totalPages && pageNumber <= maxPages) {
      const result = await callTool(JOBS_LIST_TOOL, {
        page: pageNumber,
        page_size: pageSize,
      });
      const parsed = parseJobsListResult(result);
      totalPages = parsed.totalPages;
      stats.pages += 1;
      stats.seen += parsed.jobs.length;
      rows.push(...parsed.jobs);

      if (totalPages === 0) break;
      pageNumber += 1;
    }

    if (totalPages > maxPages) {
      stats.maxPagesReached = 1;
    }

    stats.detailsSeen = rows.length;
    if (rows.length > 0) {
      const { matched, present, total } = await updateJobDescriptions(sql, {
        sourceId,
        rows,
      });
      stats.detailsMatched = matched;
      stats.detailsMissing = Math.max(0, total - present);
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
 * 默认 MCP 调用工具（收紧白名单到 `[wb.jobs.list]`）：配置从 `env`（Worker 绑定）
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
      allowedTools: [JOBS_LIST_TOOL],
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
