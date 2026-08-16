import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { createLlmDetailScoringAdapter } from "../lib/adapters/llm-detail-scoring-adapter.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import { runAutomaticMatchPipeline } from "../lib/jobs/automatic-match-pipeline.mjs";
import { runProjectionFilterSync } from "../lib/jobs/projection-filter-sync.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

const DIMENSIONS = ["skills", "industry", "seniority", "experience", "location", "salary", "activity"];

function validScoreDocument(requestItemId, { duplicateDimension = false } = {}) {
  const dims = DIMENSIONS.map((dimension) => ({
    dimension,
    assessable: true,
    score: 85,
    evidence: [
      { candidate_fact: "候选人具备该维度相关事实", job_requirement: "职位要求该维度", assessment: "评估认为匹配" },
    ],
    confidence: 0.8,
  }));
  if (duplicateDimension) dims[1].dimension = "skills";
  return {
    schema_version: "llm-detail-score/v1",
    request_item_id: requestItemId,
    dimensions: dims,
    missing_items: [],
    risks: [],
    overall_confidence: 0.8,
  };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
}
function httpError(status) {
  return { ok: false, status, json: async () => ({ error: { message: "x", code: "x" } }), headers: { get: () => null } };
}

function chatEnvelope(doc) {
  return { choices: [{ message: { role: "assistant", content: JSON.stringify(doc) }, finish_reason: "stop" }], usage: {} };
}

/** 从请求体提取 request_item_id（OpenAI 信封 user message 里的 payload JSON）。 */
function echoDocumentFetch(docFactory) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const payload = JSON.parse(body.messages[1].content);
    return okJson(chatEnvelope(docFactory(payload.request_item_id)));
  };
}

async function seedJob(sql, sourceId, externalId, requirements) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId: runId,
    rawPayload: { job_id: externalId },
    job: {
      externalId,
      title: `LLM Job ${externalId}`,
      companyName: "Fixture Co",
      ownerExternalId: "fixture-owner",
      ownerName: "Fixture Owner",
      ageDays: 9,
      lastRecommendationAt: null,
      category: "互联网",
      city: "上海",
      salaryMin: 30,
      salaryMax: 60,
      portalUrl: `https://portal.invalid/jobs/${externalId}`,
      sourceCreatedAt: null,
      eligibilityEvidence: {
        activeStatus: "provider_filter",
        zeroRecommendations: "provider_filter",
        age: "days_without_rec",
      },
    },
    encryption,
    operabilityStatus: "actionable",
  });
  await sql`
    insert into job_requirements (job_id, skills, seniority, education, salary_min, salary_max, constraints)
    values (${jobId}, ${sql.json(requirements.skills ?? [])}, ${requirements.seniority ?? null},
            ${requirements.education ?? null}, ${requirements.salaryMin ?? null}, ${requirements.salaryMax ?? null},
            ${sql.json({ min_experience_years: requirements.minExperienceYears ?? 0 })}) on conflict (job_id) do nothing
  `;
  await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
  return jobId;
}

async function seedCandidate(sql, { sourceConnectionId, externalId, displayName, profile }) {
  const [cand] = await sql`
    insert into candidates (source_connection_id, external_id, display_name, summary)
    values (${sourceConnectionId}, ${externalId}, ${displayName}, ${profile.summary ?? null})
    returning id
  `;
  await sql`
    insert into candidate_profiles (
      candidate_id, skills, experience_years, location, education, seniority,
      industry, expected_salary_min, expected_salary_max, activity_updated_at
    ) values (
      ${cand.id}, ${sql.json(profile.skills ?? [])}, ${profile.experienceYears ?? null},
      ${profile.location ?? null}, ${profile.education ?? null}, ${profile.seniority ?? null},
      ${profile.industry ?? null}, ${profile.expectedSalaryMin ?? null},
      ${profile.expectedSalaryMax ?? null}, ${profile.activityUpdatedAt ?? null}
    )
  `;
  return cand.id;
}

async function cleanup(sql, { sourceId, candidateIds, jobIds }) {
  if (sourceId) {
    const projJobIds = jobIds ?? [];
    await sql`delete from match_dimensions where match_id in (select id from matches where job_id = any(${projJobIds}))`;
    await sql`delete from matches where job_id = any(${projJobIds})`;
    await sql`
      delete from llm_score_runs where filter_result_id in (
        select fr.id from match_filter_results fr
        join job_match_projections jp on jp.id = fr.job_projection_id
        where jp.job_id = any(${projJobIds})
      )
    `;
    await sql`
      delete from match_filter_results
      where job_projection_id in (select id from job_match_projections where job_id = any(${projJobIds}))
         or candidate_projection_id in (select id from candidate_match_projections where candidate_id = any(${candidateIds ?? []}))
    `;
    await sql`delete from job_match_projections where job_id = any(${projJobIds})`;
    await sql`delete from candidate_match_projections where candidate_id = any(${candidateIds ?? []})`;
    if (candidateIds?.length) {
      await sql`delete from candidate_profiles where candidate_id = any(${candidateIds})`;
      await sql`delete from candidates where id = any(${candidateIds})`;
    }
    await sql`delete from job_requirements where job_id = any(${projJobIds})`;
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  await sql.end();
}

const REQUIREMENTS = {
  skills: ["Node.js", "PostgreSQL"],
  seniority: "高级",
  education: "本科",
  salaryMin: 30,
  salaryMax: 60,
  minExperienceYears: 5,
};

const GOOD_PROFILE = {
  skills: ["Node.js", "PostgreSQL", "React"],
  experienceYears: 7,
  location: "上海",
  education: "硕士",
  seniority: "高级",
  industry: "互联网",
  expectedSalaryMin: 35,
  expectedSalaryMax: 55,
  activityUpdatedAt: new Date(Date.now() - 10 * 86400000),
  summary: "示例公司-高级工程师",
};

/** seed 1 职位 + 1 合格候选人 → 阶段一产出 consumable 投影 + passed 过滤结果。 */
async function seedSlice(sql, marker) {
  const source = {
    provider: `fixture-llm-adapter-${marker}`,
    environment: "test",
    displayName: "Fixture LLM Adapter",
  };
  const sourceId = await getOrCreateSourceConnection(sql, source);
  const jobId = await seedJob(sql, sourceId, `llm-j1-${marker}`, REQUIREMENTS);
  const candidateId = await seedCandidate(sql, {
    sourceConnectionId: sourceId,
    externalId: `llm-c1-${marker}`,
    displayName: "张**",
    profile: GOOD_PROFILE,
  });
  const redactedDetails = new Map([
    [candidateId, { career_history: ["某互联网公司后端开发（公司名已泛化）"], project_highlights: [] }],
  ]);
  const outcome = await runProjectionFilterSync({
    sql,
    source,
    jobIds: [jobId],
    candidateRedactedDetails: redactedDetails,
    encryption,
  });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.stats.filterPassed, 1, "应产出 1 条通过硬过滤的组合");
  return { source, sourceId, jobId, candidateId };
}

test(
  "生产适配器：LLM_RATE_LIMITED 落 llm_score_runs 机器码、matches 不写、可重试",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let slice;
    try {
      slice = await seedSlice(sql, marker);
      const adapter = createLlmDetailScoringAdapter(
        { APP_ENV: "test", LLM_BASE_URL: "https://llm.example.com/v1", LLM_MODEL: "test", LLM_API_KEY: "sk-test" },
        { fetchImpl: () => httpError(429) },
      );
      const env = { APP_ENV: "test", APP_ENCRYPTION_KEY: encryption.key, APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion };
      const outcome = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.equal(outcome.status, "succeeded", "单候选失败不使整任务失败");
      const [run] = await sql`select error_code from llm_score_runs where filter_result_id in (select id from match_filter_results where job_projection_id in (select id from job_match_projections where job_id = ${slice.jobId}))`;
      assert.equal(run.error_code, "LLM_RATE_LIMITED", "错误码应落 LLM_RATE_LIMITED 而非 LLM_INTERNAL_ERROR");
      const [matchCount] = await sql`select count(*)::int as n from matches where job_id = ${slice.jobId}`;
      assert.equal(matchCount.n, 0, "失败不写 matches");
      // retryable：重跑仍应选中该组合
      const again = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.ok(again.stats.pending >= 1, "LLM_RATE_LIMITED 应可重试");
    } finally {
      if (slice) await cleanup(sql, { sourceId: slice.sourceId, candidateIds: [slice.candidateId], jobIds: [slice.jobId] });
    }
  },
);

test(
  "生产适配器：合法输出落 matches + match_dimensions + llm_score_runs succeeded，幂等重跑 scored=0",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let slice;
    try {
      slice = await seedSlice(sql, marker);
      const adapter = createLlmDetailScoringAdapter(
        { APP_ENV: "test", LLM_BASE_URL: "https://llm.example.com/v1", LLM_MODEL: "test", LLM_API_KEY: "sk-test" },
        { fetchImpl: echoDocumentFetch((requestItemId) => validScoreDocument(requestItemId)) },
      );
      const env = { APP_ENV: "test", APP_ENCRYPTION_KEY: encryption.key, APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion };
      const outcome = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.scored, 1);
      const [match] = await sql`
        select status, score_status, score from matches where job_id = ${slice.jobId} and candidate_id = ${slice.candidateId}
      `;
      assert.ok(match, "匹配应落库");
      assert.equal(match.status, "pending_review");
      assert.equal(match.score_status, "llm_aggregated");
      const [dims] = await sql`select count(*)::int as n from match_dimensions where match_id in (select id from matches where job_id = ${slice.jobId})`;
      assert.equal(dims.n, 7, "七维应全部落库");
      const [run] = await sql`
        select status from llm_score_runs
        where filter_result_id in (select id from match_filter_results where job_projection_id in (select id from job_match_projections where job_id = ${slice.jobId}))
      `;
      assert.equal(run.status, "succeeded");
      // 幂等：同版本重跑不重复评分
      const again = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.equal(again.stats.scored, 0);
      const [runCount] = await sql`
        select count(*)::int as n from llm_score_runs
        where filter_result_id in (select id from match_filter_results where job_projection_id in (select id from job_match_projections where job_id = ${slice.jobId}))
      `;
      assert.equal(runCount.n, 1, "同版本不得重复调用 LLM");
    } finally {
      if (slice) await cleanup(sql, { sourceId: slice.sourceId, candidateIds: [slice.candidateId], jobIds: [slice.jobId] });
    }
  },
);

test(
  "生产适配器：七维重复 → LLM_OUTPUT_SCHEMA_INVALID 且 terminal（重跑不再选中）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let slice;
    try {
      slice = await seedSlice(sql, marker);
      const adapter = createLlmDetailScoringAdapter(
        { APP_ENV: "test", LLM_BASE_URL: "https://llm.example.com/v1", LLM_MODEL: "test", LLM_API_KEY: "sk-test" },
        { fetchImpl: echoDocumentFetch((requestItemId) => validScoreDocument(requestItemId, { duplicateDimension: true })) },
      );
      const env = { APP_ENV: "test", APP_ENCRYPTION_KEY: encryption.key, APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion };
      const outcome = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.equal(outcome.status, "succeeded");
      const [run] = await sql`
        select error_code from llm_score_runs
        where filter_result_id in (select id from match_filter_results where job_projection_id in (select id from job_match_projections where job_id = ${slice.jobId}))
      `;
      assert.equal(run.error_code, "LLM_OUTPUT_SCHEMA_INVALID", "七维重复应被语义校验拒绝");
      // terminal：重跑不再选中该组合
      const again = await runAutomaticMatchPipeline({ sql, env, adapter });
      assert.equal(again.stats.pending, 0, "SCHEMA_INVALID 应 terminal");
    } finally {
      if (slice) await cleanup(sql, { sourceId: slice.sourceId, candidateIds: [slice.candidateId], jobIds: [slice.jobId] });
    }
  },
);
