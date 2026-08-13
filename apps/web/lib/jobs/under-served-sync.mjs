import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../adapters/mcp-discovery.mjs";
import {
  McpContractError,
  parseJobsListResult,
  parseUnderServedJobsResult,
  selectEligibleUnderServedPairs,
} from "../adapters/mcp-under-served-contract.mjs";
import {
  closeStaleUnderServedJobs,
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  markOperabilityStatus,
  persistUnderServedJob,
  startSyncRun,
} from "./job-sync-repository.mjs";

const UNDER_SERVED_TOOL = "wb.jobs.under_served";
const JOBS_LIST_TOOL = "wb.jobs.list";
/** page_size 提到上限 200（docs/validation/2026-08-11：under_served 最大 200），2796/200 ≈ 14 页，
 *  较 20×100=100 页减 7 倍；且拉全不再触发 maxPagesReached，closeStale 得以执行（fix4）。 */
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_DAYS_WITHOUT_REC = 7;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;
const OPERABILITY_ACTIONABLE = "actionable";
const OPERABILITY_NOT_IN_SCOPE = "not_in_access_scope";

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
  const callTool =
    mcp?.callTool ??
    createDefaultCallTool({ allowedTools: [UNDER_SERVED_TOOL, JOBS_LIST_TOOL] });
  const sourceId = await getOrCreateSourceConnection(sql, source);
  // 看门狗：回收崩溃残留的 running 同步运行（超时标 RUN_STALE_TIMEOUT），
  // 避免进程中断后 sync_run 永久卡 running。
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const stats = { pages: 0, seen: 0, eligible: 0, skipped: 0, operable: 0, inoperableSeen: 0, persisted: 0 };
  // 本次完整拉取见到的全部合格（7-30 天）职位 externalId：含不可操作但仍沉睡的（用于 closeStale，
  // 不把 not_in_access_scope 误标为 closed）。
  const seenExternalIds = [];
  // 本次实际写入的合格可操作职位 externalId。
  const activeExternalIds = [];
  // 见到但不可操作的沉睡职位（仅标记 operability_status，不入库业务字段）。
  const inoperableExternalIds = [];

  try {
    // fix4：只入库「账号可操作集 ∩ 沉睡」——可操作集来自 wb.jobs.list（账号自身作用域，match_candidates 可用）。
    // 放 try 内：wb.jobs.list 失败（如限流）落 failed 运行，而非裸抛出。
    const operableIds = await collectOperableJobIds(callTool);
    stats.operable = operableIds.size;

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
        seenExternalIds.push(job.externalId);
        if (operableIds.has(job.externalId)) {
          await persistUnderServedJob(sql, {
            sourceId,
            syncRunId,
            rawPayload: rawItem,
            job,
            encryption,
            operabilityStatus: OPERABILITY_ACTIONABLE,
          });
          stats.persisted += 1;
          activeExternalIds.push(job.externalId);
        } else {
          // 上游仍沉睡但账号不可操作：不是「已关闭」，标记 not_in_access_scope（不入库业务字段）。
          inoperableExternalIds.push(job.externalId);
        }
      }

      if (totalPages === 0) break;
      pageNumber += 1;
    }

    if (totalPages > maxPages) {
      stats.maxPagesReached = 1;
    }

    stats.inoperableSeen = inoperableExternalIds.length;
    await markOperabilityStatus(sql, {
      sourceId,
      externalIds: inoperableExternalIds,
      status: OPERABILITY_NOT_IN_SCOPE,
    });

    // 全量拉取成功才关闭陈旧沉睡职位；maxPages 截断时跳过，避免误关未拉取到的职位。
    // seenExternalIds 含不可操作职位，因此仅关闭真正未见的（上游消失/退出沉睡）。
    if (!stats.maxPagesReached) {
      stats.closedStale = await closeStaleUnderServedJobs(sql, {
        sourceId,
        seenExternalIds,
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
 * 拉取账号自身作用域（可操作集）的职位 ID：`wb.jobs.list` 分页，返回 externalId 集合。
 * 可操作 = 该集合职位可调 `match_candidates` 不越界（validation 2026-08-12：1003 Data not found
 * 只发生在非自身职位）；集外沉睡职位标记 `not_in_access_scope`，不入库业务字段。
 */
async function collectOperableJobIds(callTool) {
  const ids = new Set();
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 3) {
    const result = await callTool(JOBS_LIST_TOOL, {
      page,
      page_size: 100,
    });
    const list = parseJobsListResult(result);
    for (const { externalId } of list.jobs) {
      ids.add(externalId);
    }
    totalPages = list.totalPages;
    if (list.jobs.length === 0) break;
    page += 1;
  }
  return ids;
}

/**
 * 默认 MCP 调用工具：配置从 `env`（Worker 绑定）或缺省 process.env 解析。
 * 兼容旧调用 `createDefaultCallTool(actorId)`（字符串）；新调用 `createDefaultCallTool({ env })`。
 * `allowedTools` 可覆盖白名单（缺省仅 under_served；job-details 同步用它收紧到 `[JOBS_GET_TOOL]`，
 * 见 job-details-sync.mjs）。
 */
export function createDefaultCallTool(options = {}) {
  const { actorId, env, allowedTools = [UNDER_SERVED_TOOL] } =
    typeof options === "string" ? { actorId: options } : options;
  const config = loadMcpDiscoveryConfig(env);
  return async (toolName, toolArguments) =>
    callMcpTool({
      ...config,
      actorId,
      toolName,
      arguments: toolArguments,
      allowedTools,
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
