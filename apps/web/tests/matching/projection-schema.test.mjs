import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCandidateMatchProjection,
  validateJobRequirementProjection,
  validateLlmDetailScore,
} from "../../lib/matching/projection-schemas.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

/** 合法职位要求投影（v1 Schema 全字段齐备）。 */
function jobProjectionDoc(overrides = {}) {
  return {
    schema_version: "job-requirement-projection/v1",
    projection_id: UUID,
    job_id: UUID2,
    input_hash: HASH,
    generator_type: "rules",
    generator_version: "rules/v1",
    generated_at: "2026-08-13T00:00:00.000Z",
    source_snapshot_refs: [
      {
        source_connection_id: UUID,
        raw_record_id: UUID2,
        contract_version: "under-served-v1",
        mapping_version: "m1",
        captured_at: "2026-08-13T00:00:00.000Z",
      },
    ],
    display_summary: "高级后端工程师（上海）薪资 30-60",
    hard_requirements: {
      locations: ["上海"],
      required_skills: ["Node.js", "PostgreSQL"],
      min_experience_years: 5,
      education_min: "bachelor",
      required_certificates: [],
      salary: {
        minimum: 30,
        maximum: 60,
        period: "month",
        currency: "CNY",
        hard_constraint: true,
      },
    },
    scoring_context: {
      responsibilities: ["负责后端服务开发"],
      preferred_skills: ["React"],
      industry: "互联网",
      seniority: "高级",
      business_context: null,
    },
    extraction_warnings: [],
    ...overrides,
  };
}

/** 合法候选人脱敏匹配投影（v1 Schema 全字段齐备）。 */
function candidateProjectionDoc(overrides = {}) {
  return {
    schema_version: "candidate-match-projection/v1",
    projection_id: UUID,
    candidate_id: UUID2,
    input_hash: HASH,
    generator_version: "rules/v1",
    redaction_version: "redact/v1",
    generated_at: "2026-08-13T00:00:00.000Z",
    source_snapshot_refs: [
      {
        source_connection_id: UUID,
        raw_record_id: null,
        contract_version: null,
        mapping_version: "m1",
        captured_at: "2026-08-13T00:00:00.000Z",
      },
    ],
    display_summary: "张**，高级后端工程师，上海，7 年经验",
    profile: {
      skills: ["Node.js", "PostgreSQL", "React"],
      experience_years: 7,
      city: "上海",
      education: "master",
      certificates: [],
      seniority: "高级",
      industry: "互联网",
      expected_salary: {
        minimum: 35,
        maximum: 55,
        period: "month",
        currency: "CNY",
      },
      activity_updated_at: "2026-08-01T00:00:00.000Z",
    },
    redacted_detail: {
      career_history: ["某互联网公司后端开发（公司名已泛化）"],
      project_highlights: ["参与某高并发项目（项目名已泛化）"],
    },
    redaction_report: {
      removed_categories: ["name", "phone", "email"],
      generalized_categories: ["company_name", "project_name"],
      residual_pii_scan: "passed",
    },
    ...overrides,
  };
}

/** 合法 LLM 详情维度评分（v1 Schema：7 维、可评估/不可评估、证据与置信度）。 */
function llmScoreDoc(overrides = {}) {
  return {
    schema_version: "llm-detail-score/v1",
    request_item_id: "req-abcdef1234567890",
    dimensions: [
      { dimension: "skills", assessable: true, score: 100, evidence: [{ candidate_fact: "掌握 Node.js", job_requirement: "要求 Node.js", assessment: "完全覆盖" }], confidence: 0.95 },
      { dimension: "industry", assessable: true, score: 100, evidence: [{ candidate_fact: "互联网行业", job_requirement: "互联网", assessment: "一致" }], confidence: 0.9 },
      { dimension: "seniority", assessable: true, score: 100, evidence: [{ candidate_fact: "高级", job_requirement: "高级", assessment: "一致" }], confidence: 0.9 },
      { dimension: "experience", assessable: true, score: 100, evidence: [{ candidate_fact: "7 年", job_requirement: "≥5 年", assessment: "满足" }], confidence: 0.9 },
      { dimension: "location", assessable: true, score: 100, evidence: [{ candidate_fact: "上海", job_requirement: "上海", assessment: "同城" }], confidence: 0.9 },
      { dimension: "salary", assessable: true, score: 100, evidence: [{ candidate_fact: "期望 35-55", job_requirement: "30-60", assessment: "在范围内" }], confidence: 0.9 },
      { dimension: "activity", assessable: false, score: null, evidence: [], confidence: 0.5 },
    ],
    missing_items: [],
    risks: [],
    overall_confidence: 0.9,
    ...overrides,
  };
}

test("三份 v1 Schema 可编译且合法 Fixture 文档通过校验", async () => {
  assert.deepEqual(await validateJobRequirementProjection(jobProjectionDoc()), { ok: true });
  assert.deepEqual(await validateCandidateMatchProjection(candidateProjectionDoc()), { ok: true });
  assert.deepEqual(await validateLlmDetailScore(llmScoreDoc()), { ok: true });
});

test("职位投影：未知字段被拒（additionalProperties:false）", async () => {
  const result = await validateJobRequirementProjection(
    jobProjectionDoc({ company_name: "某公司" }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("职位投影：input_hash 必须为 64 位 hex", async () => {
  const bad = await validateJobRequirementProjection(
    jobProjectionDoc({ input_hash: "short" }),
  );
  assert.equal(bad.ok, false);
  const good = await validateJobRequirementProjection(jobProjectionDoc());
  assert.equal(good.ok, true);
});

test("候选人投影：residual_pii_scan 必须为 passed（残留 PII 拒绝）", async () => {
  const leaked = await validateCandidateMatchProjection(
    candidateProjectionDoc({
      redaction_report: {
        removed_categories: ["name"],
        generalized_categories: [],
        residual_pii_scan: "failed",
      },
    }),
  );
  assert.equal(leaked.ok, false, "residual_pii_scan=failed 必须被 Schema 拒绝");
});

test("候选人投影：redacted_detail 缺失关键字段被拒", async () => {
  const result = await validateCandidateMatchProjection(
    candidateProjectionDoc({
      redacted_detail: { career_history: [] }, // 缺 project_highlights
    }),
  );
  assert.equal(result.ok, false);
});

test("LLM 评分：维度必须恰好 7 个且枚举固定", async () => {
  const dup = await validateLlmDetailScore(
    llmScoreDoc({
      dimensions: llmScoreDoc().dimensions.slice(0, 6), // 只有 6 维
    }),
  );
  assert.equal(dup.ok, false);

  const badDim = await validateLlmDetailScore(
    llmScoreDoc({
      dimensions: llmScoreDoc().dimensions.map((d, i) =>
        i === 0 ? { ...d, dimension: "unknown" } : d,
      ),
    }),
  );
  assert.equal(badDim.ok, false);
});

test("LLM 评分：不可评估维度必须 score:null 且证据为空；可评估必须整数分", async () => {
  const assessedNull = await validateLlmDetailScore(
    llmScoreDoc({
      dimensions: llmScoreDoc().dimensions.map((d, i) =>
        i === 0 ? { ...d, assessable: true, score: null } : d,
      ),
    }),
  );
  assert.equal(assessedNull.ok, false, "assessable=true 且 score=null 被拒");

  const nonAssessedScore = await validateLlmDetailScore(
    llmScoreDoc({
      dimensions: llmScoreDoc().dimensions.map((d, i) =>
        i === 6 ? { ...d, assessable: false, score: 50, evidence: [{ candidate_fact: "x", job_requirement: "y", assessment: "z" }] } : d,
      ),
    }),
  );
  assert.equal(nonAssessedScore.ok, false, "assessable=false 但 score≠null 被拒");
});

test("LLM 评分：score 超界（>100）被拒", async () => {
  const out = await validateLlmDetailScore(
    llmScoreDoc({
      dimensions: llmScoreDoc().dimensions.map((d, i) =>
        i === 0 ? { ...d, score: 101 } : d,
      ),
    }),
  );
  assert.equal(out.ok, false);
});
