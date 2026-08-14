import { decryptJsonPayload, encryptJsonPayload } from "../security/payload-encryption.mjs";
import {
  AGGREGATION_RULE_VERSION,
  aggregateDetailScore,
  deriveMatchRuleVersion,
  hashCanonical,
} from "../matching/aggregate-detail-score.mjs";
import { createFakeDetailScoringAdapter } from "../matching/fake-detail-scoring-adapter.mjs";
import { validateLlmDetailScore } from "../matching/projection-schemas.mjs";
import { replaceMatchDimensions, upsertMatch } from "./match-repository.mjs";

export const MATCH_PIPELINE_TASK_KIND = "match_pipeline_v2";

export function resolveDetailScoringAdapter(env, injectedAdapter) {
  if (injectedAdapter) return injectedAdapter;
  const configured = env.MATCH_SCORING_ADAPTER;
  const nonProduction = env.APP_ENV !== "production";
  if (configured === "fake" || (!configured && nonProduction)) return createFakeDetailScoringAdapter();
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
      const request = {
        requestItemId: `item_${item.combinedInputHash.slice(0, 24)}`,
        jobProjection: item.jobRequirements,
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
    select fr.id as "filterResultId", fr.filter_rule_version as "filterRuleVersion",
      fr.combined_input_hash as "combinedInputHash",
      jp.id as "jobProjectionId", jp.job_id as "jobId", jp.requirements as "jobRequirements",
      cp.id as "candidateProjectionId", cp.candidate_id as "candidateId", cp.profile as "candidateProfile",
      cp.redacted_detail_ciphertext as "redactedDetailCiphertext",
      cp.redacted_detail_nonce as "redactedDetailNonce", cp.key_version as "keyVersion"
    from match_filter_results fr
    join job_match_projections jp on jp.id = fr.job_projection_id
    join candidate_match_projections cp on cp.id = fr.candidate_projection_id
    where fr.passed = true and jp.status = 'consumable' and cp.status = 'consumable'
      and not exists (
        select 1 from llm_score_runs run
        where run.filter_result_id = fr.id and run.status = 'succeeded'
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
        where terminal.filter_result_id = fr.id and terminal.status = 'failed'
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
        where retry.filter_result_id = fr.id
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
    return { ...item, attempt: attemptRow.attempt, preRank: preRank(item.jobRequirements, item.candidateProfile) };
  }));
}

function preRank(job, candidate) {
  const required = job?.hard_requirements?.required_skills ?? [];
  const skills = (candidate?.skills ?? []).map((value) => String(value).toLowerCase());
  const skillHits = required.filter((value) => skills.includes(String(value).toLowerCase())).length;
  const cityHit = (job?.hard_requirements?.locations ?? []).includes(candidate?.city) ? 1 : 0;
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
function classifyScoreError(error) {
  const code = error instanceof Error ? error.message : "";
  return ["LLM_OUTPUT_SCHEMA_INVALID", "NO_ASSESSABLE_DIMENSIONS"].includes(code) ? code : "LLM_INTERNAL_ERROR";
}
function failure(errorCode, retryable) { return { status: "failed", errorCode, retryable, stats: null }; }
