import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../adapters/mcp-discovery.mjs";
import { parseMatchCandidatesResult } from "../adapters/mcp-under-served-contract.mjs";
import { scoreMatch } from "../matching/score.mjs";
import {
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  startSyncRun,
} from "./job-sync-repository.mjs";
import {
  replaceMatchDimensions,
  updateMatchExternalReference,
  upsertMatch,
} from "./match-repository.mjs";

export const MATCH_CANDIDATES_TOOL = "wb.jobs.match_candidates";
export const MATCH_LOCAL_SYNC_TYPE = "match_local_jobs";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_RULE_VERSION = 1;
const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * 匹配任务流（M2，ADR-005 主路径）：对选定可操作职位，用**本地确定性评分引擎**
 * （lib/matching/score.mjs）对候选池逐个评分，把可复算结果落库为 matches/match_dimensions。
 *
 * - 候选池 = 本地 candidates + candidate_profiles（虚构 Fixture seed 或真实适配器接入，
 *   本切片 Fixture 闭环）；硬过滤不过的 (职位, 候选人) 不入池。
 * - 每个落库结果保存：总分/分带/维度分/证据/缺失/风险/输入哈希/规则版本（docs/01 §1.3 可复算）。
 * - **外部对照**：若提供 `mcp`，对每个职位调 `wb.jobs.match_candidates`，把供应方
 *   total_score/tier/score_status 写入 `matches.external_*`（**非权威分**，docs/04）。
 * - 单职位失败跳过不毒化整轮；权限边界（1003/1004）不重试不换身份。
 *
 * `mcp.callTool` 可注入（测试用假客户端）；Fixture 闭环可不提供（external_* 为 null）。
 */
export async function runMatchSync({
  sql,
  source,
  jobIds = [],
  ruleVersion = DEFAULT_RULE_VERSION,
  batchSize = DEFAULT_BATCH_SIZE,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
  mcp,
}) {
  // callTool 仅用于可选的供应方外部对照；Fixture 闭环不提供 mcp 时不创建（避免依赖真实 MCP 配置）。
  const callTool = mcp ? (mcp.callTool ?? createMatchCallTool()) : null;
  const sourceId = await getOrCreateSourceConnection(sql, source);
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, MATCH_LOCAL_SYNC_TYPE);
  const stats = {
    jobsQueried: 0,
    candidatesScored: 0,
    matchesStored: 0,
    hardFiltered: 0,
    failed: 0,
  };

  try {
    const pool = await loadCandidatePool(sql);
    if (pool.length === 0) {
      await finishSyncRun(sql, syncRunId, stats);
      return { status: "succeeded", syncRunId, sourceId, stats };
    }

    for (const jobId of jobIds.slice(0, batchSize)) {
      const [job] = await sql`
        select id, external_id, category, city, salary_min, salary_max
        from jobs where id = ${jobId}
      `;
      if (!job) {
        stats.failed += 1;
        continue;
      }
      stats.jobsQueried += 1;

      const requirements = await loadJobRequirements(sql, job);
      if (!requirements) {
        stats.failed += 1;
        continue;
      }

      for (const cand of pool) {
        const result = scoreMatch({
          jobRequirements: requirements,
          candidateProfile: cand,
          ruleVersion,
        });
        if (!result.passed) {
          stats.hardFiltered += 1;
          continue;
        }
        stats.candidatesScored += 1;

        const { id: matchId } = await upsertMatch(sql, {
          jobId: job.id,
          candidateId: cand.candidateId,
          score: result.totalScore,
          band: result.band,
          status: "generated",
          ruleVersion,
          scoreStatus: "local_computed",
          inputHash: result.inputHash,
          evidence: result.evidence,
          missing: result.missing,
          risk: result.risk,
        });
        await replaceMatchDimensions(sql, {
          matchId,
          dimensions: result.dimensions.map((d) => ({
            dimension: d.dimension,
            score: d.score,
            evidence: d.evidence,
            risk: d.risk,
          })),
        });
        stats.matchesStored += 1;
      }

      // 外部对照（可选）：供应方 match_candidates 结果写入 external_*，不作为权威分。
      if (callTool) {
        await recordExternalReference(callTool, sql, job, pool, ruleVersion);
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
      retryable: isRetryableError(error),
      stats: failureStats,
    };
  }
}

/** 候选池：本地全部候选人 + 画像（虚构 Fixture seed 或真实适配器）。 */
async function loadCandidatePool(sql) {
  return sql`
    select
      c.id as "candidateId",
      c.external_id as "externalId",
      c.display_name as "displayName",
      c.summary,
      p.skills,
      p.experience_years as "experienceYears",
      p.location,
      p.education,
      p.seniority,
      p.industry,
      p.expected_salary_min as "expectedSalaryMin",
      p.expected_salary_max as "expectedSalaryMax",
      p.activity_updated_at as "activityUpdatedAt"
    from candidates c
    join candidate_profiles p on p.candidate_id = c.id
  `;
}

/** 职位要求：job_requirements 优先；无则从 jobs 派生（city/salary/category）。 */
async function loadJobRequirements(sql, job) {
  const [req] = await sql`
    select skills, seniority, education, salary_min, salary_max, constraints
    from job_requirements where job_id = ${job.id}
  `;
  const constraints = req?.constraints ?? {};
  return {
    skills: req?.skills ?? [],
    seniority: req?.seniority ?? null,
    education: req?.education ?? null,
    salaryMin: req?.salary_min ?? job.salary_min ?? null,
    salaryMax: req?.salary_max ?? job.salary_max ?? null,
    location: job.city ?? null,
    industry: job.category ?? null,
    min_experience_years: constraints.min_experience_years ?? 0,
  };
}

/** 外部对照：调 match_candidates 并把供应方结果写入已落库匹配的 external_*。 */
async function recordExternalReference(callTool, sql, job, pool, ruleVersion) {
  const byExternalId = new Map(pool.map((c) => [c.externalId, c]));
  try {
    const result = await callTool(MATCH_CANDIDATES_TOOL, {
      job_id: job.external_id,
      page: 1,
      page_size: 50,
      min_score: 75,
      max_llm_score_count: 1,
    });
    const parsed = parseMatchCandidatesResult(result);
    for (const m of parsed.matches) {
      const local = byExternalId.get(m.candidateId);
      if (!local) continue; // 供应方返回但本地无画像的候选人，仅作对照记录缺失
      await updateMatchExternalReference(sql, {
        jobId: job.id,
        externalCandidateId: m.candidateId,
        externalScore: m.totalScore,
        externalTier: m.tier,
        externalScoreStatus: m.scoreStatus,
        ruleVersion,
      });
    }
  } catch (error) {
    // 外部对照失败不毒化本地评分（仅跳过对照，本地 matches 已落库）
    if (process.env.NODE_ENV !== "test") {
      console.error("[match-sync] external reference skipped:", error?.message);
    }
  }
}

/**
 * 默认 MCP 调用工具（白名单收紧到 `[wb.jobs.match_candidates]`，仅外部对照用）。
 */
export function createMatchCallTool(options = {}) {
  const { actorId, env } =
    typeof options === "string" ? { actorId: options } : options;
  const config = loadMcpDiscoveryConfig(env);
  return async (toolName, toolArguments) =>
    callMcpTool({
      ...config,
      actorId,
      toolName,
      arguments: toolArguments,
      allowedTools: [MATCH_CANDIDATES_TOOL],
    });
}

function classifySyncError(error) {
  if (error instanceof McpDiscoveryError) {
    return typeof error.code === "string" && error.code ? error.code : "MCP_ERROR";
  }
  return "SYNC_INTERNAL_ERROR";
}

/** 网络类错误（MCP 连接/限流/超时）标记 retryable，供任务表调度退避重试。 */
function isRetryableError(error) {
  return error instanceof McpDiscoveryError && error.retryable === true;
}
