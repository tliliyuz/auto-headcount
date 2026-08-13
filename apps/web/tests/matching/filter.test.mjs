import assert from "node:assert/strict";
import test from "node:test";

import { hardFilter } from "../../lib/matching/filter.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

/** 职位要求投影（符合 job-requirement-projection/v1 关键字段）。 */
function jobProj(overrides = {}) {
  return {
    projection_id: UUID,
    input_hash: HASH,
    hard_requirements: {
      locations: ["上海"],
      required_skills: ["Node.js", "PostgreSQL"],
      min_experience_years: 5,
      education_min: "bachelor",
      required_certificates: ["PMP"],
      salary: { minimum: 30, maximum: 60, period: "month", currency: "CNY", hard_constraint: true },
    },
    ...overrides,
  };
}

/** 候选人脱敏匹配投影（符合 candidate-match-projection/v1 关键字段）。 */
function candProj(overrides = {}) {
  return {
    projection_id: UUID,
    input_hash: HASH,
    profile: {
      skills: ["Node.js", "PostgreSQL", "React"],
      experience_years: 7,
      city: "上海",
      education: "master",
      certificates: ["PMP"],
      expected_salary: { minimum: 35, maximum: 55, period: "month", currency: "CNY" },
    },
    ...overrides,
  };
}

test("hardFilter：全部硬要求满足 → passed:true 且无原因码", () => {
  const result = hardFilter({ jobProjection: jobProj(), candidateProjection: candProj() });
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasonCodes, []);
  assert.match(result.combinedInputHash, /^[a-f0-9]{64}$/);
});

test("hardFilter：地点不匹配 → LOCATION_MISMATCH", () => {
  const result = hardFilter({
    jobProjection: jobProj({ hard_requirements: { ...jobProj().hard_requirements, locations: ["北京"] } }),
    candidateProjection: candProj(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "LOCATION_MISMATCH"));
});

test("hardFilter：必备技能缺失 → REQUIRED_SKILL_MISSING", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({ profile: { ...candProj().profile, skills: ["Java"] } }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "REQUIRED_SKILL_MISSING"));
});

test("hardFilter：年限不足 → EXPERIENCE_BELOW_MINIMUM", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({ profile: { ...candProj().profile, experience_years: 3 } }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "EXPERIENCE_BELOW_MINIMUM"));
});

test("hardFilter：学历不足 → EDUCATION_BELOW_MINIMUM", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({ profile: { ...candProj().profile, education: "associate" } }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "EDUCATION_BELOW_MINIMUM"));
});

test("hardFilter：证书缺失 → CERTIFICATE_MISSING", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({ profile: { ...candProj().profile, certificates: [] } }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "CERTIFICATE_MISSING"));
});

test("hardFilter：薪资硬约束无交集 → SALARY_NO_OVERLAP", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({
      profile: {
        ...candProj().profile,
        expected_salary: { minimum: 80, maximum: 100, period: "month", currency: "CNY" },
      },
    }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasonCodes.some((r) => r.code === "SALARY_NO_OVERLAP"));
});

test("hardFilter：薪资非硬约束 → 无 SALARY_NO_OVERLAP（软性处理）", () => {
  const result = hardFilter({
    jobProjection: jobProj({
      hard_requirements: { ...jobProj().hard_requirements, salary: { ...jobProj().hard_requirements.salary, hard_constraint: false } },
    }),
    candidateProjection: candProj({
      profile: { ...candProj().profile, expected_salary: { minimum: 80, maximum: 100, period: "month", currency: "CNY" } },
    }),
  });
  assert.equal(result.reasonCodes.some((r) => r.code === "SALARY_NO_OVERLAP"), false);
});

test("hardFilter：职位关键硬要求缺失 → REQUIRED_FIELD_MISSING（默认不过）", () => {
  const noSkills = hardFilter({
    jobProjection: jobProj({
      hard_requirements: { ...jobProj().hard_requirements, required_skills: [] },
    }),
    candidateProjection: candProj(),
  });
  assert.equal(noSkills.passed, false);
  assert.ok(noSkills.reasonCodes.some((r) => r.code === "REQUIRED_FIELD_MISSING"));

  const noLocations = hardFilter({
    jobProjection: jobProj({
      hard_requirements: { ...jobProj().hard_requirements, locations: [] },
    }),
    candidateProjection: candProj(),
  });
  assert.equal(noLocations.passed, false);
  assert.ok(noLocations.reasonCodes.some((r) => r.code === "REQUIRED_FIELD_MISSING"));
});

test("hardFilter：combined_input_hash 确定性复算、内容变化则变化", () => {
  const input = { jobProjection: jobProj(), candidateProjection: candProj() };
  assert.equal(
    hardFilter(input).combinedInputHash,
    hardFilter(input).combinedInputHash,
    "同输入同哈希",
  );
  const changed = hardFilter({
    jobProjection: jobProj({ input_hash: "b".repeat(64) }),
    candidateProjection: candProj(),
  });
  assert.notEqual(changed.combinedInputHash, hardFilter(input).combinedInputHash);
});

test("hardFilter：每条原因携带职位/候选人值与人类可读解释", () => {
  const result = hardFilter({
    jobProjection: jobProj(),
    candidateProjection: candProj({ profile: { ...candProj().profile, skills: ["Java"] } }),
  });
  const skill = result.reasonCodes.find((r) => r.code === "REQUIRED_SKILL_MISSING");
  assert.ok(skill.jobValue.includes("Node.js"));
  assert.ok(skill.candidateValue.includes("Java"));
  assert.ok(skill.explanation.length > 0);
});
