import assert from "node:assert/strict";
import test from "node:test";

import { generateJobProjection } from "../../lib/matching/job-projection.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";

function job(overrides = {}) {
  return {
    id: UUID,
    title: "高级后端工程师",
    companyName: "某真实公司名", // 不得出现在 display_summary
    category: "互联网",
    city: "上海",
    salaryMin: 30,
    salaryMax: 60,
    jobDescription: "负责后端服务开发，要求 Node.js 与 PostgreSQL。",
    ...overrides,
  };
}

function requirements(overrides = {}) {
  return {
    skills: ["Node.js", "PostgreSQL"],
    seniority: "高级",
    education: "本科",
    salaryMin: 30,
    salaryMax: 60,
    constraints: {
      min_experience_years: 5,
      required_certificates: [],
    },
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    job: job(),
    requirements: requirements(),
    jd: job().jobDescription,
    sourceSnapshotRefs: [
      {
        source_connection_id: UUID,
        raw_record_id: null,
        contract_version: null,
        mapping_version: "m1",
        captured_at: "2026-08-13T00:00:00.000Z",
      },
    ],
    generatorType: "rules",
    generatorVersion: "rules/v1",
    generatedAt: "2026-08-13T00:00:00.000Z",
    projectionId: UUID,
    ...overrides,
  };
}

test("generateJobProjection：生成过 Schema 的职位投影文档", async () => {
  const result = await generateJobProjection(baseInput());
  assert.equal(result.ok, true);
  const doc = result.projection;
  assert.equal(doc.schema_version, "job-requirement-projection/v1");
  assert.equal(doc.job_id, UUID);
  assert.equal(doc.generator_type, "rules");
  assert.deepEqual(doc.hard_requirements.locations, ["上海"]);
  assert.deepEqual(doc.hard_requirements.required_skills, ["Node.js", "PostgreSQL"]);
  assert.equal(doc.hard_requirements.min_experience_years, 5);
  assert.equal(doc.hard_requirements.education_min, "bachelor", "本科映射为 bachelor 枚举");
  assert.equal(doc.hard_requirements.salary.minimum, 30);
  assert.equal(doc.hard_requirements.salary.period, "month");
  assert.equal(doc.hard_requirements.salary.currency, "CNY");
  assert.ok(doc.scoring_context.responsibilities.length >= 1, "从 JD 提取职责");
  assert.ok(doc.extraction_warnings.length >= 0);
});

test("generateJobProjection：display_summary ≤150 且不含公司名/联系方式", async () => {
  const result = await generateJobProjection(baseInput());
  const doc = result.projection;
  assert.ok(doc.display_summary.length <= 150, "摘要不超 150 字");
  assert.ok(!doc.display_summary.includes("某真实公司名"), "摘要不含公司名");
  assert.ok(!/1[3-9]\d{9}|@/.test(doc.display_summary), "摘要不含手机/邮箱");
});

test("generateJobProjection：input_hash 稳定、64 位 hex、源内容变化则变化", async () => {
  const first = await generateJobProjection(baseInput());
  const second = await generateJobProjection(baseInput());
  assert.equal(first.ok, true);
  assert.equal(first.inputHash, second.inputHash, "同输入同哈希");
  assert.match(first.inputHash, /^[a-f0-9]{64}$/);

  const changedSalary = await generateJobProjection(
    baseInput({ job: job({ salaryMax: 80 }) }),
  );
  assert.notEqual(changedSalary.inputHash, first.inputHash, "薪资变化 → 新哈希（版本不覆盖依据）");
});

test("generateJobProjection：关键硬要求缺失时 extraction_warnings 提示，但不阻塞生成", async () => {
  const result = await generateJobProjection(
    baseInput({
      job: job({ city: null, salaryMin: null, salaryMax: null }),
      requirements: requirements({ skills: [] }),
    }),
  );
  assert.equal(result.ok, true, "缺失字段进 warnings 而非失败（REQUIRED_FIELD_MISSING 属过滤层）");
  assert.ok(result.projection.extraction_warnings.length > 0);
});
