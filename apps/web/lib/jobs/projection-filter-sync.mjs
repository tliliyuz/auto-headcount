/**
 * M3 两阶段匹配·阶段一垂直切片：投影生成 + 第一轮确定性硬过滤（docs/05 M3 当前状态）。
 *
 * 对选定可操作职位 + 本地候选池：
 * - 生成并落库职位要求投影（job_match_projections，`consumable`）；
 * - 生成并落库候选人脱敏匹配投影（candidate_match_projections，`consumable`；
 *   残留 PII → `MATCH_PROJECTION_PII_DETECTED`，跳过并计入 stats）；
 * - 逐 (job, candidate) 跑 `hardFilter`（lib/matching/filter.mjs，纯函数）→ 落库
 *   match_filter_results（通过/剔除原因，不可变幂等）。
 *
 * 阶段二（LLM 脱敏详情评分 + 本地汇总）不在本切片；`passed=false` 不创建 LLM 运行（docs/10 §5）。
 * 仿 runMatchSync（match-sync.mjs）：source connection + sync_run 审计 + stats + 失败机器码。
 * 本切片不新增任务 kind / API 端点——调度接线随阶段二一并落地。
 *
 * `encryption` 必须提供（候选人 redacted_detail 落库加密）。
 */

import {
  failStaleRunningSyncRuns,
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  startSyncRun,
} from "./job-sync-repository.mjs";
import {
  insertCandidateProjection,
  insertJobProjection,
} from "./projection-repository.mjs";
import { insertMatchFilterResult } from "./filter-repository.mjs";
import { hardFilter } from "../matching/filter.mjs";
import { JOB_PROJECTION_SCHEMA } from "../matching/job-projection.mjs";
import { generateJobProjection } from "../matching/job-projection.mjs";
import {
  CANDIDATE_PROJECTION_SCHEMA,
  generateCandidateProjection,
} from "../matching/candidate-projection.mjs";

export const PROJECTION_FILTER_SYNC_TYPE = "match_projection_filter";
export const DEFAULT_FILTER_RULE_VERSION = "v1";
export const DEFAULT_GENERATOR_VERSION = "rules/v1";
export const DEFAULT_REDACTION_VERSION = "redact/v1";
export const DEFAULT_STALE_SYNC_RUN_MS = 30 * 60 * 1000;

/**
 * 投影生成 + 硬过滤垂直切片。
 * @param {object} opts
 * @param {object} opts.sql - postgres client
 * @param {object} opts.source - { provider, environment, displayName }
 * @param {string[]} opts.jobIds - 可操作职位 id
 * @param {string} [opts.filterRuleVersion]
 * @param {string} [opts.generatorVersion]
 * @param {string} [opts.redactionVersion]
 * @param {Map<string, object>|Record<string, object>} [opts.candidateRedactedDetails]
 *        - 候选人 id → 已脱敏简历详情 {career_history[], project_highlights[]}（本切片由调用方注入）
 * @param {object} opts.encryption - { key, keyVersion }（候选人 redacted_detail 落库加密）
 * @param {number} [opts.staleSyncRunMs]
 * @param {() => Date} [opts.now]
 */
export async function runProjectionFilterSync({
  sql,
  source,
  jobIds = [],
  filterRuleVersion = DEFAULT_FILTER_RULE_VERSION,
  generatorVersion = DEFAULT_GENERATOR_VERSION,
  redactionVersion = DEFAULT_REDACTION_VERSION,
  candidateRedactedDetails = {},
  encryption,
  staleSyncRunMs = DEFAULT_STALE_SYNC_RUN_MS,
  now = () => new Date(),
}) {
  if (!encryption?.key || !encryption?.keyVersion) {
    throw new Error("encryption { key, keyVersion } is required for candidate projection");
  }
  const redactedMap =
    candidateRedactedDetails instanceof Map
      ? candidateRedactedDetails
      : new Map(Object.entries(candidateRedactedDetails ?? {}));

  const sourceId = await getOrCreateSourceConnection(sql, source);
  await failStaleRunningSyncRuns(sql, {
    staleBefore: new Date(now().getTime() - staleSyncRunMs),
  });
  const syncRunId = await startSyncRun(sql, sourceId, PROJECTION_FILTER_SYNC_TYPE);
  const stats = {
    jobsQueried: 0,
    jobsProjected: 0,
    candidatesQueried: 0,
    candidatesProjected: 0,
    piiRejected: 0,
    filterPassed: 0,
    filterRejected: 0,
    failed: 0,
  };

  try {
    const pool = await loadCandidatePool(sql);
    stats.candidatesQueried = pool.length;

    // 候选人来源快照引用：本切片候选池来自本地 candidates/candidate_profiles（M2 未接来源追溯），
    // 统一以本次同步的 source_connection 作为内部追溯来源（docs/10 §2：仅内部，不发给 LLM）。
    const candidateSourceRefs = [
      {
        source_connection_id: sourceId,
        raw_record_id: null,
        contract_version: null,
        mapping_version: "candidate-profile-v1",
        captured_at: now().toISOString(),
      },
    ];

    // 预生成候选人投影（含 PII 扫描）——每个候选人只做一次，供所有职位复用。
    const candidateProjections = [];
    for (const cand of pool) {
      const redactedDetail = redactedMap.get(cand.candidateId) ?? null;
      if (!redactedDetail) {
        stats.piiRejected += 1; // 无脱敏详情来源 → 不产出消费态投影（本切片按异常跳过）
        continue;
      }
      const generated = await generateCandidateProjection({
        candidate: cand,
        profile: cand,
        redactedDetail,
        sourceSnapshotRefs: candidateSourceRefs,
        generatorVersion,
        redactionVersion,
        generatedAt: now().toISOString(),
      });
      if (!generated.ok) {
        stats.piiRejected += 1;
        continue;
      }
      const { id: projectionId } = await insertCandidateProjection(
        sql,
        {
          candidateId: cand.candidateId,
          schemaVersion: CANDIDATE_PROJECTION_SCHEMA,
          generatorVersion,
          redactionVersion,
          inputHash: generated.inputHash,
          sourceSnapshotRefs: candidateSourceRefs,
          displaySummary: generated.projection.display_summary,
          profile: generated.projection.profile,
          redactedDetail: generated.projection.redacted_detail,
          redactionReport: generated.projection.redaction_report,
          status: "consumable",
        },
        encryption,
      );
      candidateProjections.push({
        projectionId,
        document: generated.projection,
        inputHash: generated.inputHash,
      });
      stats.candidatesProjected += 1;
    }

    for (const jobId of jobIds) {
      const job = await loadJob(sql, jobId);
      if (!job) {
        stats.failed += 1;
        continue;
      }
      stats.jobsQueried += 1;

      const generated = await generateJobProjection({
        job,
        requirements: job.requirements,
        jd: job.job_description,
        sourceSnapshotRefs: job.sourceSnapshotRefs ?? [],
        generatorVersion,
        generatedAt: now().toISOString(),
      });
      if (!generated.ok) {
        stats.failed += 1;
        continue;
      }
      const { id: jobProjectionId } = await insertJobProjection(sql, {
        jobId: job.id,
        schemaVersion: JOB_PROJECTION_SCHEMA,
        generatorType: "rules",
        generatorVersion,
        inputHash: generated.inputHash,
        sourceSnapshotRefs: job.sourceSnapshotRefs ?? [],
        displaySummary: generated.projection.display_summary,
        requirements: {
          hard_requirements: generated.projection.hard_requirements,
          scoring_context: generated.projection.scoring_context,
          extraction_warnings: generated.projection.extraction_warnings,
        },
        status: "consumable",
      });
      stats.jobsProjected += 1;

      for (const cand of candidateProjections) {
        const filter = hardFilter({
          jobProjection: generated.projection,
          candidateProjection: cand.document,
          filterRuleVersion,
        });
        await insertMatchFilterResult(sql, {
          jobProjectionId,
          candidateProjectionId: cand.projectionId,
          filterRuleVersion,
          combinedInputHash: filter.combinedInputHash,
          passed: filter.passed,
          reasonCodes: filter.reasonCodes,
        });
        if (filter.passed) stats.filterPassed += 1;
        else stats.filterRejected += 1;
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

/** 候选池：本地全部候选人 + 画像（虚构 Fixture seed 或真实适配器接入）。 */
async function loadCandidatePool(sql) {
  return sql`
    select
      c.id as "candidateId",
      c.id as "id",
      c.external_id as "externalId",
      c.display_name as "displayName",
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

/** 职位 + job_requirements + 来源引用（本切片用 jobs 行 + 派生 sourceSnapshotRefs）。 */
async function loadJob(sql, jobId) {
  const [job] = await sql`
    select
      j.id, j.external_id, j.title, j.category, j.city,
      j.salary_min, j.salary_max, j.job_description,
      j.source_connection_id, j.raw_record_id
    from jobs j where j.id = ${jobId}
  `;
  if (!job) return null;
  const [req] = await sql`
    select skills, seniority, education, salary_min, salary_max, constraints
    from job_requirements where job_id = ${jobId}
  `;
  const constraints = req?.constraints ?? {};
  return {
    ...job,
    requirements: {
      skills: req?.skills ?? [],
      seniority: req?.seniority ?? null,
      education: req?.education ?? null,
      salaryMin: req?.salary_min ?? null,
      salaryMax: req?.salary_max ?? null,
      constraints,
    },
    // 职位来源快照引用（docs/10 §2：仅内部追溯，不发给 LLM）。raw_record 缺失时以 source_connection 为来源。
    sourceSnapshotRefs: [
      {
        source_connection_id: job.source_connection_id,
        raw_record_id: job.raw_record_id ?? null,
        contract_version: null,
        mapping_version: "under-served-v1",
        captured_at: new Date(0).toISOString(), // 占位：真实采集时间随 M2 来源追溯
      },
    ],
  };
}

function classifySyncError(error) {
  if (error && typeof error.code === "string" && error.code) return error.code;
  return "SYNC_INTERNAL_ERROR";
}
