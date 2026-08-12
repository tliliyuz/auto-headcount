import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../adapters/mcp-discovery.mjs";
import {
  McpContractError,
  parseUnderServedJobsResult,
  selectEligibleUnderServedPairs,
} from "../adapters/mcp-under-served-contract.mjs";
import {
  closeStaleUnderServedJobs,
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "./job-sync-repository.mjs";

const UNDER_SERVED_TOOL = "wb.jobs.under_served";
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_DAYS_WITHOUT_REC = 7;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * 分页拉取 `wb.jobs.under_served` 并入库的可审计同步任务。
 *
 * - 每个合格职位（ageDays 7–30）把原始上游载荷加密追加写 `raw_records`，
 *   并幂等更新规范化 `jobs`（`source_connection_id + external_id`）。
 * - 成功调用 `finishSyncRun`；失败仅把机器可读 `error_code` 写入 `sync_runs`
 *   （`failSyncRun`），不落原始错误正文或任何凭证。
 * - 部分成功后再失败时，已入库行关联到 `failed` 运行；消费方须按
 *   `sync_runs.status = 'succeeded'` 过滤。
 *
 * `mcp.callTool` 可注入（测试用假客户端）；缺省使用真实适配器，且 MCP 配置在
 * 任何数据库写入前解析，配置错误会直接抛出。
 */
export async function runUnderServedSync({
  sql,
  encryption,
  source,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  daysWithoutRec = DEFAULT_DAYS_WITHOUT_REC,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
  mcp,
}) {
  const callTool = mcp?.callTool ?? createDefaultCallTool(mcp?.actorId);
  const sourceId = await getOrCreateSourceConnection(sql, source);
  // 看门狗：回收崩溃残留的 running 同步运行（超时标 RUN_STALE_TIMEOUT），
  // 避免进程中断后 sync_run 永久卡 running。
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const stats = { pages: 0, seen: 0, eligible: 0, skipped: 0, persisted: 0 };
  // 本次全量同步实际写入的合格职位 externalId（用于关闭陈旧沉睡职位）。
  const activeExternalIds = [];

  try {
    let pageNumber = 1;
    let totalPages = 1;

    while (pageNumber <= totalPages && pageNumber <= maxPages) {
      const result = await callTool(UNDER_SERVED_TOOL, {
        days_without_rec: daysWithoutRec,
        page: pageNumber,
        page_size: pageSize,
      });
      const page = parseUnderServedJobsResult(result);
      totalPages = page.totalPages;
      stats.pages += 1;
      stats.seen += page.jobs.length;

      const pairs = selectEligibleUnderServedPairs(page);
      stats.eligible += pairs.length;
      stats.skipped += page.jobs.length - pairs.length;

      for (const { job, rawItem } of pairs) {
        await persistUnderServedJob(sql, {
          sourceId,
          syncRunId,
          rawPayload: rawItem,
          job,
          encryption,
        });
        stats.persisted += 1;
        activeExternalIds.push(job.externalId);
      }

      if (totalPages === 0) break;
      pageNumber += 1;
    }

    if (totalPages > maxPages) {
      stats.maxPagesReached = 1;
    }

    // 全量拉取成功才关闭陈旧沉睡职位；maxPages 截断时跳过，避免误关未拉取到的职位。
    if (!stats.maxPagesReached) {
      stats.closedStale = await closeStaleUnderServedJobs(sql, {
        sourceId,
        activeExternalIds,
      });
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
 * 默认 MCP 调用工具：配置从 `env`（Worker 绑定）或缺省 process.env 解析。
 * 兼容旧调用 `createDefaultCallTool(actorId)`（字符串）；新调用 `createDefaultCallTool({ env })`。
 */
export function createDefaultCallTool(options = {}) {
  const { actorId, env } =
    typeof options === "string" ? { actorId: options } : options;
  const config = loadMcpDiscoveryConfig(env);
  return async (toolName, toolArguments) =>
    callMcpTool({
      ...config,
      actorId,
      toolName,
      arguments: toolArguments,
      allowedTools: [UNDER_SERVED_TOOL],
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
