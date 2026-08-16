import { decryptJsonPayload, encryptJsonPayload } from "../security/payload-encryption.mjs";
import {
  AGGREGATION_RULE_VERSION,
  aggregateDetailScore,
  deriveMatchRuleVersion,
  hashCanonical,
} from "../matching/aggregate-detail-score.mjs";
import { createFakeDetailScoringAdapter } from "../matching/fake-detail-scoring-adapter.mjs";
import { validateLlmDetailScore } from "../matching/projection-schemas.mjs";
import { createLlmDetailScoringAdapter } from "../adapters/llm-detail-scoring-adapter.mjs";
import { replaceMatchDimensions, upsertMatch } from "./match-repository.mjs";

export const MATCH_PIPELINE_TASK_KIND = "match_pipeline_v2";

/** 管线可识别的 LLM 失败机器码（docs/10 §6.3 + LLM_AUTH_FAILED）。白名单外一律 LLM_INTERNAL_ERROR。 */
export const LLM_ERROR_CODE_WHITELIST = Object.freeze([
  "LLM_TIMEOUT",
  "LLM_RATE_LIMITED",
  "LLM_UNAVAILABLE",
  "LLM_INPUT_TOO_LARGE",
  "LLM_SAFETY_REFUSAL",
  "LLM_AUTH_FAILED",
  "LLM_OUTPUT_SCHEMA_INVALID",
  "NO_ASSESSABLE_DIMENSIONS",
]);

export function resolveDetailScoringAdapter(env, injectedAdapter) {
  if (injectedAdapter) return injectedAdapter;
  const configured = env.MATCH_SCORING_ADAPTER;
  const nonProduction = env.APP_ENV !== "production";
  if (configured === "fake" || (!configured && nonProduction)) return createFakeDetailScoringAdapter();
  // 生产形状适配器：供应商无关、配置驱动（env）。配置不完整 → resolve 即抛
  // LLM_ADAPTER_CONFIG_INVALID（fail-closed）。未知值/生产未配 → null（LLM_ADAPTER_NOT_CONFIGURED）。
  if (configured === "llm-openai-compatible") return createLlmDetailScoringAdapter(env);
  return null;
}

export async function runAutomaticMatchPipeline({
  sql,
  env,
  adapter: injectedAdapter,
  maxCandidatesPerJob = Number(env.MATCH_TOP_K ?? 10),
  globalBudget = Number(env.MATCH_RUN_BUDGET ?? 20),
  maxAttempts = Number(env.MATCH_SCORE_MAX_ATTEMPTS ?? 3),
  now = () => new Date(),
}) {
  const adapter = resolveDetailScoringAdapter(env, injectedAdapter);
  if (!adapter) return failure("LLM_ADAPTER_NOT_CONFIGURED", false);
  const encryption = { key: env.APP_ENCRYPTION_KEY, keyVersion: env.APP_ENCRYPTION_KEY_VERSION };
  if (!encryption.key || !encryption.keyVersion) return failure("ENCRYPTION_CONFIG_REQUIRED", false);

  const metadata = adapter.metadata;
  const candidates = await loadPendingCandidates(sql, metadata, maxAttempts);
  const selected = selectBudgetedCandidates(candidates, { maxCandidatesPerJob, globalBudget });
  const stats = { pending: candidates.length, selected: selected.length, scored: 0, failed: 0, deferred: candidates.length - selected.length };

  for (const item of selected) {
    let runId;
    try {
      const redactedDetail = await decryptJsonPayload({
        ciphertext: item.redactedDetailCiphertext,
        nonce: item.redactedDetailNonce,
        keyVersion: item.keyVersion,
      }, { key: encryption.key });
      // 同 JD 多城市职位合并为代表：把代表投影的 locations 覆盖为组内城市并集
      // （城市已非硬门槛，跨城市候选人由 location 评分维度评估；requestHash 覆盖后计算如实记录实际发送内容）。
      const jobProjection = withMergedLocations(item.jobRequirements, item.groupCities);
      const request = {
        requestItemId: `item_${item.combinedInputHash.slice(0, 24)}`,
        jobProjection,
        candidateProjection: { profile: item.candidateProfile, redactedDetail },
      };
      const requestHash = await hashCanonical(request);
      runId = await startScoreRun(sql, item, metadata, requestHash, now(), AGGREGATION_RULE_VERSION);
      const output = await adapter.score(request);
      const validated = await validateLlmDetailScore(output);
      if (!validated.ok) throw new Error("LLM_OUTPUT_SCHEMA_INVALID");
      const encrypted = await encryptJsonPayload(output, encryption);
      await finishScoreRun(sql, runId, encrypted, now());
      const aggregate = await aggregateDetailScore(output);
      const versionBundle = {
        filterRuleVersion: item.filterRuleVersion,
        projectionInputHash: item.combinedInputHash,
        ...metadata,
        aggregationRuleVersion: AGGREGATION_RULE_VERSION,
      };
      const ruleVersion = await deriveMatchRuleVersion(versionBundle);
      const inputHash = await hashCanonical({ filter: item.combinedInputHash, output: encrypted.payloadHash, versionBundle });
      const match = await upsertMatch(sql, {
        jobId: item.jobId,
        candidateId: item.candidateId,
        score: aggregate.score,
        band: aggregate.band,
        status: "pending_review",
        ruleVersion,
        scoreStatus: "llm_aggregated",
        inputHash,
        evidence: aggregate.evidence,
        missing: aggregate.missing,
        risk: aggregate.risk,
        jobProjectionId: item.jobProjectionId,
        candidateProjectionId: item.candidateProjectionId,
        filterResultId: item.filterResultId,
        llmScoreRunId: runId,
        aggregationRuleVersion: AGGREGATION_RULE_VERSION,
      });
      await replaceMatchDimensions(sql, {
        matchId: match.id,
        dimensions: aggregate.dimensions.map((dimension) => ({
          dimension: dimension.dimension,
          score: dimension.score,
          assessable: dimension.assessable,
          confidence: dimension.confidence,
          evidence: dimension.evidence?.map((entry) => entry.assessment).join("；") || null,
          risk: null,
          llmScoreRunId: runId,
          outputHash: encrypted.payloadHash,
        })),
      });
      stats.scored += 1;
    } catch (error) {
      stats.failed += 1;
      if (runId) await failScoreRun(sql, runId, classifyScoreError(error), now());
    }
  }
  return { status: "succeeded", retryable: false, errorCode: null, stats };
}

export function selectBudgetedCandidates(items, { maxCandidatesPerJob, globalBudget }) {
  const counts = new Map();
  return [...items]
    .sort((left, right) => right.preRank - left.preRank || String(left.filterResultId).localeCompare(String(right.filterResultId)))
    .filter((item) => {
      const count = counts.get(item.jobId) ?? 0;
      if (count >= maxCandidatesPerJob) return false;
      counts.set(item.jobId, count + 1);
      return true;
    })
    .slice(0, globalBudget);
}

async function loadPendingCandidates(sql, metadata, maxAttempts) {
  const rows = await sql`
    with job_group as (
      select j.id as "jobId", j.city as "city",
        case
          when j.job_description is null or btrim(j.job_description) = '' then null
          else encode(sha256(convert_to(btrim(j.job_description), 'UTF8')), 'hex')
        end as "jdHash"
      from jobs j
      where j.status = 'active'
    ),
    eligible as (
      select fr.id as "filterResultId", fr.filter_rule_version as "filterRuleVersion",
        fr.combined_input_hash as "combinedInputHash",
        jp.id as "jobProjectionId", jp.job_id as "jobId", jp.requirements as "jobRequirements",
        cp.id as "candidateProjectionId", cp.candidate_id as "candidateId", cp.profile as "candidateProfile",
        cp.redacted_detail_ciphertext as "redactedDetailCiphertext",
        cp.redacted_detail_nonce as "redactedDetailNonce", cp.key_version as "keyVersion",
        jg."jdHash" as "jdHash"
      from match_filter_results fr
      join job_match_projections jp on jp.id = fr.job_projection_id
      join candidate_match_projections cp on cp.id = fr.candidate_projection_id
      join job_group jg on jg."jobId" = jp.job_id
      where fr.passed = true and jp.status = 'consumable' and cp.status = 'consumable'
    ),
    representative as (
      select eligible.*,
        row_number() over (
          partition by coalesce("jdHash", 'job:' || "jobId"), "candidateProjectionId"
          order by "jobId"
        ) as "rn"
      from eligible
    )
    select r."filterResultId", r."filterRuleVersion", r."combinedInputHash",
      r."jobProjectionId", r."jobId", r."jobRequirements",
      r."candidateProjectionId", r."candidateId", r."candidateProfile",
      r."redactedDetailCiphertext", r."redactedDetailNonce", r."keyVersion",
      r."jdHash",
      (
        select coalesce(
          array_agg(distinct g2."city" order by g2."city") filter (where g2."city" <> ''),
          '{}'::text[]
        )
        from job_group g2
        where g2."jdHash" = r."jdHash"
      ) as "groupCities"
    from representative r
    where r."rn" = 1
      and not exists (
        select 1 from llm_score_runs run
        where run.filter_result_id = r."filterResultId" and run.status = 'succeeded'
          and run.adapter_id = ${metadata.adapterId}
          and run.adapter_version = ${metadata.adapterVersion}
          and run.model_id = ${metadata.modelId}
          and coalesce(run.model_revision, '') = ${metadata.modelRevision ?? ""}
          and run.prompt_version = ${metadata.promptVersion}
          and run.schema_version = ${metadata.schemaVersion}
          and run.parameters ->> 'aggregationRuleVersion' = ${AGGREGATION_RULE_VERSION}
      )
      and not exists (
        select 1 from llm_score_runs terminal
        where terminal.filter_result_id = r."filterResultId" and terminal.status = 'failed'
          and terminal.adapter_id = ${metadata.adapterId}
          and terminal.adapter_version = ${metadata.adapterVersion}
          and terminal.model_id = ${metadata.modelId}
          and coalesce(terminal.model_revision, '') = ${metadata.modelRevision ?? ""}
          and terminal.prompt_version = ${metadata.promptVersion}
          and terminal.schema_version = ${metadata.schemaVersion}
          and terminal.parameters ->> 'aggregationRuleVersion' = ${AGGREGATION_RULE_VERSION}
          and terminal.error_code not in ('LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_INTERNAL_ERROR')
      )
      and (
        select count(*) from llm_score_runs retry
        where retry.filter_result_id = r."filterResultId"
          and retry.adapter_id = ${metadata.adapterId}
          and retry.adapter_version = ${metadata.adapterVersion}
          and retry.model_id = ${metadata.modelId}
          and coalesce(retry.model_revision, '') = ${metadata.modelRevision ?? ""}
          and retry.prompt_version = ${metadata.promptVersion}
          and retry.schema_version = ${metadata.schemaVersion}
          and retry.parameters ->> 'aggregationRuleVersion' = ${AGGREGATION_RULE_VERSION}
      ) < ${maxAttempts}
  `;
  return Promise.all(rows.map(async (item) => {
    const [attemptRow] = await sql`
      select count(*)::int + 1 as attempt from llm_score_runs
      where filter_result_id = ${item.filterResultId}
        and adapter_id = ${metadata.adapterId} and adapter_version = ${metadata.adapterVersion}
        and model_id = ${metadata.modelId} and prompt_version = ${metadata.promptVersion}
        and schema_version = ${metadata.schemaVersion}
        and parameters ->> 'aggregationRuleVersion' = ${AGGREGATION_RULE_VERSION}
    `;
    return {
      ...item,
      attempt: attemptRow.attempt,
      preRank: preRank(item.jobRequirements, item.candidateProfile, item.groupCities),
    };
  }));
}

/**
 * 同 JD 职位城市并集覆盖：groupCities 非空时克隆 jobRequirements 并把
 * `hard_requirements.locations` 覆盖为组内城市并集（代表职位吸收全组城市，
 * 跨城市候选人由 location 评分维度评估）；空/undefined 返回原对象不覆盖。
 */
export function withMergedLocations(jobRequirements, groupCities) {
  if (!Array.isArray(groupCities) || groupCities.length === 0) return jobRequirements;
  return {
    ...jobRequirements,
    hard_requirements: {
      ...(jobRequirements?.hard_requirements ?? {}),
      locations: groupCities,
    },
  };
}

/**
 * 稳定预排序：技能命中 + 城市命中。城市命中优先用组内城市并集（groupCities），
 * 空则回退 job.locations（保持无去重时的原行为）。
 */
export function preRank(job, candidate, groupCities) {
  const required = job?.hard_requirements?.required_skills ?? [];
  const skills = (candidate?.skills ?? []).map((value) => String(value).toLowerCase());
  const skillHits = required.filter((value) => skills.includes(String(value).toLowerCase())).length;
  const locations =
    Array.isArray(groupCities) && groupCities.length > 0
      ? groupCities
      : (job?.hard_requirements?.locations ?? []);
  const cityHit = locations.includes(candidate?.city) ? 1 : 0;
  return skillHits * 10 + cityHit;
}

async function startScoreRun(sql, item, metadata, requestHash, startedAt, aggregationRuleVersion) {
  const [row] = await sql`
    insert into llm_score_runs (
      filter_result_id, attempt, status, adapter_id, adapter_version, model_id, model_revision,
      prompt_version, schema_version, request_hash, parameters, started_at
    ) values (
      ${item.filterResultId}, ${item.attempt}, 'running', ${metadata.adapterId}, ${metadata.adapterVersion},
      ${metadata.modelId}, ${metadata.modelRevision ?? null}, ${metadata.promptVersion},
      ${metadata.schemaVersion}, ${requestHash}, ${sql.json({ aggregationRuleVersion })}, ${startedAt}
    ) returning id
  `;
  return row.id;
}

async function finishScoreRun(sql, id, encrypted, finishedAt) {
  await sql`update llm_score_runs set status = 'succeeded', response_ciphertext = ${encrypted.ciphertext}, response_nonce = ${encrypted.nonce}, key_version = ${encrypted.keyVersion}, output_hash = ${encrypted.payloadHash}, finished_at = ${finishedAt} where id = ${id}`;
}
async function failScoreRun(sql, id, errorCode, finishedAt) {
  await sql`update llm_score_runs set status = 'failed', error_code = ${errorCode}, finished_at = ${finishedAt} where id = ${id}`;
}
export function classifyScoreError(error) {
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  return LLM_ERROR_CODE_WHITELIST.includes(code) ? code : "LLM_INTERNAL_ERROR";
}
function failure(errorCode, retryable) { return { status: "failed", errorCode, retryable, stats: null }; }
