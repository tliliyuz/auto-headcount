import assert from "node:assert/strict";
import test from "node:test";

import { generateCandidateProjection } from "../../lib/matching/candidate-projection.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";

function candidate(overrides = {}) {
  return {
    id: UUID,
    externalId: "cand-001",
    displayName: "张**", // 打码名
    summary: null,
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    skills: ["Node.js", "PostgreSQL", "React"],
    experienceYears: 7,
    location: "上海",
    education: "硕士",
    seniority: "高级",
    industry: "互联网",
    expectedSalaryMin: 35,
    expectedSalaryMax: 55,
    activityUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function redactedDetail(overrides = {}) {
  return {
    career_history: ["某互联网公司后端开发（公司名已泛化）"],
    project_highlights: ["参与某高并发项目（项目名已泛化）"],
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    candidate: candidate(),
    profile: profile(),
    redactedDetail: redactedDetail(),
    sourceSnapshotRefs: [
      {
        source_connection_id: UUID,
        raw_record_id: null,
        contract_version: null,
        mapping_version: "m1",
        captured_at: "2026-08-13T00:00:00.000Z",
      },
    ],
    generatorVersion: "rules/v1",
    redactionVersion: "redact/v1",
    generatedAt: "2026-08-13T00:00:00.000Z",
    projectionId: UUID,
    ...overrides,
  };
}

test("generateCandidateProjection：生成过 Schema 的脱敏投影（residual_pii_scan=passed）", async () => {
  const result = await generateCandidateProjection(baseInput());
  assert.equal(result.ok, true);
  const doc = result.projection;
  assert.equal(doc.schema_version, "candidate-match-projection/v1");
  assert.equal(doc.candidate_id, UUID);
  assert.deepEqual(doc.profile.skills, ["Node.js", "PostgreSQL", "React"]);
  assert.equal(doc.profile.education, "master", "硕士映射为 master 枚举");
  assert.equal(doc.profile.city, "上海");
  assert.equal(doc.redaction_report.residual_pii_scan, "passed");
  assert.ok(doc.redacted_detail.career_history.length >= 1);
  assert.ok(doc.display_summary.length <= 150);
});

test("generateCandidateProjection：display_summary ≤150 且不含联系方式/直接身份标识", async () => {
  const result = await generateCandidateProjection(baseInput());
  const doc = result.projection;
  assert.ok(doc.display_summary.length <= 150);
  assert.ok(!/1[3-9]\d{9}|@/.test(doc.display_summary), "摘要不含手机/邮箱");
  assert.ok(!doc.display_summary.includes("某真实公司名"), "摘要不含原始公司名");
});

test("generateCandidateProjection：简历详情残留手机号 → PII 拒绝", async () => {
  const result = await generateCandidateProjection(
    baseInput({
      redactedDetail: redactedDetail({
        career_history: ["某公司任职，联系电话 13800138000"],
      }),
    }),
  );
  assert.equal(result.ok, false, "残留手机号必须被拒绝");
  assert.equal(result.errorCode, "MATCH_PROJECTION_PII_DETECTED");
});

test("generateCandidateProjection：简历详情残留邮箱 → PII 拒绝", async () => {
  const result = await generateCandidateProjection(
    baseInput({
      redactedDetail: redactedDetail({
        project_highlights: ["联系邮箱 example@corp.com"],
      }),
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MATCH_PROJECTION_PII_DETECTED");
});

test("generateCandidateProjection：input_hash 稳定、源画像变化则变化", async () => {
  const first = await generateCandidateProjection(baseInput());
  const second = await generateCandidateProjection(baseInput());
  assert.equal(first.ok, true);
  assert.equal(first.inputHash, second.inputHash);
  assert.match(first.inputHash, /^[a-f0-9]{64}$/);

  const changed = await generateCandidateProjection(
    baseInput({ profile: profile({ experienceYears: 9 }) }),
  );
  assert.notEqual(changed.inputHash, first.inputHash);
});
