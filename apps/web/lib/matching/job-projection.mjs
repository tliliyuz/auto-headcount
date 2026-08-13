/**
 * 职位要求投影生成器（docs/10 §3，job-requirement-projection/v1）。
 *
 * 纯函数 + 可选 Schema 校验：把规范化 `jobs` 字段 + `job_requirements` + 完整 JD
 * 投影为不可变的版本化职位要求文档，记录 schema_version/generator 版本、来源快照引用、
 * 输入哈希和生成时间。源内容变化 → input_hash 变化 → 新投影（版本不覆盖，docs/10 §2）。
 *
 * `display_summary` 复用 summaries/summary.mjs（≤150 字、无公司名/联系方式）。
 * 硬要求只放明确、不可妥协的条件；提取不确定时保留为缺失并在 extraction_warnings 提示，
 * 不猜测为硬条件（docs/10 §3.1）。缺失关键字段不阻塞生成（REQUIRED_FIELD_MISSING 属过滤层）。
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import { summarizeJob } from "../summaries/summary.mjs";
import { validateJobRequirementProjection } from "./projection-schemas.mjs";

export const JOB_PROJECTION_SCHEMA = "job-requirement-projection/v1";

/** 中文教育层级 → 契约枚举（docs/contracts：none/high_school/associate/bachelor/master/doctorate）。 */
const EDUCATION_ENUM = {
  高中: "high_school",
  大专: "associate",
  本科: "bachelor",
  硕士: "master",
  博士: "doctorate",
};

/**
 * 生成职位要求投影。
 * @param {object} input
 * @param {object} input.job - 规范化 jobs 行（title/category/city/salary_min/salary_max/id）
 * @param {object} input.requirements - job_requirements（skills/seniority/education/salary/constraints）
 * @param {string|null} input.jd - 完整 JD（可空）
 * @param {Array} input.sourceSnapshotRefs - 来源快照引用（docs/10 §3.1）
 * @param {"rules"|"llm_extraction"|"human_reviewed"} input.generatorType
 * @param {string} input.generatorVersion - 生成器版本（不变则同输入可复算）
 * @param {string} input.generatedAt - ISO 时间
 * @param {string} [input.projectionId] - 投影 id（缺省随机）
 * @returns {Promise<{ok:true, projection:object, inputHash:string} | {ok:false, errors:unknown[]}>}
 */
export async function generateJobProjection({
  job,
  requirements,
  jd,
  sourceSnapshotRefs,
  generatorType = "rules",
  generatorVersion,
  generatedAt,
  projectionId = randomUUID(),
}) {
  const normalized = normalizeJobInput({ job, requirements, generatorVersion });
  const inputHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  const warnings = extractJobWarnings({ job, requirements, jd });
  const doc = {
    schema_version: JOB_PROJECTION_SCHEMA,
    projection_id: projectionId,
    job_id: job.id,
    input_hash: inputHash,
    generator_type: generatorType,
    generator_version: generatorVersion,
    generated_at: generatedAt,
    source_snapshot_refs: normalizeSnapshotRefs(sourceSnapshotRefs),
    display_summary: summarizeJob(toSummaryJob(job)),
    hard_requirements: buildHardRequirements({ job, requirements }),
    scoring_context: buildScoringContext({ job, requirements, jd }),
    extraction_warnings: warnings,
  };

  const validated = await validateJobRequirementProjection(doc);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }
  return { ok: true, projection: doc, inputHash };
}

/** 硬要求：地点/必备技能/最低年限/学历/证书/薪资边界（docs/01 §1.3 阶段一输入）。 */
function buildHardRequirements({ job, requirements }) {
  const constraints = requirements?.constraints ?? {};
  const skills = requirements?.skills ?? [];
  const certificates = constraints.required_certificates ?? [];
  const salaryHard = typeof constraints.salary_hard_constraint === "boolean"
    ? constraints.salary_hard_constraint
    : true; // 明确薪资边界默认硬约束（docs/01 §1.3）
  return {
    locations: job.city ? [job.city] : [],
    required_skills: skills,
    min_experience_years: constraints.min_experience_years ?? null,
    education_min: mapEducation(requirements?.education ?? null),
    required_certificates: certificates,
    salary: {
      minimum: job.salary_min ?? requirements?.salaryMin ?? null,
      maximum: job.salary_max ?? requirements?.salaryMax ?? null,
      period: "month",
      currency: "CNY",
      hard_constraint: salaryHard,
    },
  };
}

/** 详情评分上下文：职责/优选/行业/职级/业务背景（已移除公司名/客户/联系人）。 */
function buildScoringContext({ job, requirements, jd }) {
  const responsibilities = parseResponsibilities(jd);
  const constraints = requirements?.constraints ?? {};
  return {
    responsibilities,
    preferred_skills: constraints.preferred_skills ?? [],
    industry: job.category ?? null,
    seniority: requirements?.seniority ?? null,
    business_context: constraints.business_context ?? null,
  };
}

/** 从 JD 提取职责清单（确定性：按行/分号切分，去空、截断）。 */
function parseResponsibilities(jd) {
  if (!jd) return [];
  return String(jd)
    .split(/[。；;]\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 500)
    .slice(0, 30);
}

/** 关键字段缺失/冲突 → warnings（进人工处理，不阻塞生成）。 */
function extractJobWarnings({ job, requirements }) {
  const warnings = [];
  if (!job.city) warnings.push("缺少工作地点，硬过滤按不限地点处理");
  if (!(requirements?.skills ?? []).length) warnings.push("缺少必备技能清单，硬过滤无法校验技能");
  if (job.salary_min == null || job.salary_max == null) {
    warnings.push("缺少明确薪资边界，硬过滤薪资维度按中性处理");
  }
  if (requirements?.education && !EDUCATION_ENUM[requirements.education]) {
    warnings.push(`无法识别的学历要求：${requirements.education}，按未指定处理`);
  }
  return warnings;
}

function mapEducation(value) {
  if (!value) return null;
  return EDUCATION_ENUM[value] ?? null;
}

/** summarizeJob 期望 camelCase 薪资字段；DB 行是 snake_case，这里统一转换。 */
function toSummaryJob(job) {
  return {
    title: job.title,
    category: job.category,
    city: job.city,
    salaryMin: job.salary_min ?? job.salaryMin ?? null,
    salaryMax: job.salary_max ?? job.salaryMax ?? null,
  };
}

function normalizeJobInput({ job, requirements, generatorVersion }) {
  return {
    generatorVersion,
    job: {
      title: job.title ?? null,
      category: job.category ?? null,
      city: job.city ?? null,
      salaryMin: job.salary_min ?? job.salaryMin ?? null,
      salaryMax: job.salary_max ?? job.salaryMax ?? null,
    },
    requirements: {
      skills: [...(requirements?.skills ?? [])].sort(),
      seniority: requirements?.seniority ?? null,
      education: requirements?.education ?? null,
      constraints: requirements?.constraints ?? {},
    },
  };
}

function normalizeSnapshotRefs(refs) {
  return (refs ?? []).map((r) => ({
    source_connection_id: r.source_connection_id,
    raw_record_id: r.raw_record_id ?? null,
    contract_version: r.contract_version ?? null,
    mapping_version: r.mapping_version,
    captured_at: r.captured_at,
  }));
}
