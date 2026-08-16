import {
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  startSyncRun,
} from "./job-sync-repository.mjs";
import {
  JOB_REQUIREMENTS_GENERATOR_VERSION,
  extractJobRequirements,
} from "./job-requirements-extract.mjs";
import {
  selectJobsNeedingRequirementsExtraction,
  upsertJobRequirements,
} from "./job-requirements-repository.mjs";

export const JOB_REQUIREMENTS_SYNC_TYPE = "job_requirements_extract";
export const JOB_REQUIREMENTS_TASK_KIND = "job_requirements_extract";
export const DEFAULT_GENERATOR_VERSION = JOB_REQUIREMENTS_GENERATOR_VERSION;
const DEFAULT_BATCH_LIMIT = 100;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * `job_requirements_extract` 同步：确定性 JD 结构化提取，填充 `job_requirements`
 * （M3 职位侧数据缺口）。纯本地计算，无 MCP/LLM 依赖。
 *
 * - **fill-when-missing**：只处理 `job_description is not null` 且尚无 `job_requirements`
 *   行的 active 职位；空 JD 也落一行（全 null + warning），避免每 6h 重扫。
 * - 单行提取/写入失败仅计入 `failed` 并跳过，不毒化整轮。
 * - 幂等：`job_id` unique + `on conflict do update`；重复运行对已填职位不再选择。
 */
export async function runJobRequirementsSync({
  sql,
  source,
  generatorVersion = DEFAULT_GENERATOR_VERSION,
  batchLimit = DEFAULT_BATCH_LIMIT,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
}) {
  const sourceId = await getOrCreateSourceConnection(sql, source);
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, JOB_REQUIREMENTS_SYNC_TYPE);
  const stats = { jobsQueried: 0, written: 0, failed: 0, warnings: 0, generatorVersion };

  try {
    const rows = await selectJobsNeedingRequirementsExtraction(sql, { limit: batchLimit });
    stats.jobsQueried = rows.length;

    for (const row of rows) {
      try {
        const result = extractJobRequirements({
          title: row.title,
          category: row.category,
          jobDescription: row.job_description,
        });
        await upsertJobRequirements(sql, { jobId: row.id, requirements: result });
        stats.written += 1;
        stats.warnings += result.extraction_warnings.length;
      } catch {
        stats.failed += 1; // 单职位失败跳过，不毒化整轮
      }
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
      retryable: false,
      stats: failureStats,
    };
  }
}

function classifySyncError(error) {
  return typeof error?.code === "string" && error.code ? error.code : "SYNC_INTERNAL_ERROR";
}
