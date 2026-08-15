/**
 * 候选人脱敏匹配投影生成器（docs/10 §4，candidate-match-projection/v1）。
 *
 * 纯函数 + 可选 Schema 校验：把打码候选人 + 结构化画像 + 脱敏简历详情投影为
 * 不可变的版本化脱敏文档，记录 schema_version/generator/redaction 版本、来源快照引用、
 * 输入哈希和生成时间。
 *
 * **PII 拒绝（docs/10 §4.1、07 §2）**：生成前对 `profile` + `redacted_detail` 做确定性
 * 残留 PII 扫描（手机/邮箱/证件号/详址等）。命中 → 返回 `{ ok:false, errorCode:
 * "MATCH_PROJECTION_PII_DETECTED" }`，不产出消费态投影（LLM 调用被拒绝，进脱敏异常队列）。
 * 未命中 → `redaction_report.residual_pii_scan="passed"` 才允许消费。
 *
 * `display_summary` 复用 summaries/summary.mjs（≤150 字、无联系方式/直接身份标识）。
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import { summarizeCandidate } from "../summaries/summary.mjs";
import { validateCandidateMatchProjection } from "./projection-schemas.mjs";

export const CANDIDATE_PROJECTION_SCHEMA = "candidate-match-projection/v1";
export const PII_DETECTED_ERROR = "MATCH_PROJECTION_PII_DETECTED";

/** 中文教育层级 → 契约枚举。 */
const EDUCATION_ENUM = {
  高中: "high_school",
  大专: "associate",
  本科: "bachelor",
  硕士: "master",
  博士: "doctorate",
};

/** 残留 PII 扫描规则（确定性，docs/10 §4.1 必须移除/泛化类别）。 */
const PII_PATTERNS = [
  { category: "phone", pattern: /(?:^|[^0-9])(1[3-9]\d{9})(?:[^0-9]|$)/ },
  { category: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { category: "id_number", pattern: /\b\d{17}[\dXx]\b/ },
  { category: "detailed_address", pattern: /(?:省|市|区|路|号|栋|单元|层)\s*[\dA-Za-z-]+/ },
];

/**
 * 生成候选人脱敏匹配投影。
 * @param {object} input
 * @param {object} input.candidate - candidates 行（id/external_id/display_name 打码名）
 * @param {object} input.profile - candidate_profiles（skills/experienceYears/location/education/…）
 * @param {object} input.redactedDetail - 已脱敏简历详情 {career_history[], project_highlights[]}
 * @param {Array} input.sourceSnapshotRefs - 来源快照引用
 * @param {string} input.generatorVersion
 * @param {string} input.redactionVersion
 * @param {string} input.generatedAt - ISO 时间
 * @param {string} [input.projectionId]
 * @returns {Promise<{ok:true, projection:object, inputHash:string} | {ok:false, errorCode:string, reason?:string}>}
 */
export async function generateCandidateProjection({
  candidate,
  profile,
  redactedDetail,
  sourceSnapshotRefs,
  generatorVersion,
  redactionVersion,
  generatedAt,
  projectionId = randomUUID(),
}) {
  const piiScan = scanResidualPii({ profile, redactedDetail });
  if (piiScan.detected.length > 0) {
    return {
      ok: false,
      errorCode: PII_DETECTED_ERROR,
      reason: `残留 PII 类别：${piiScan.detected.join("、")}`,
    };
  }

  const normalized = normalizeCandidateInput({
    candidate,
    profile,
    redactedDetail,
    generatorVersion,
    redactionVersion,
  });
  const inputHash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  const doc = {
    schema_version: CANDIDATE_PROJECTION_SCHEMA,
    projection_id: projectionId,
    candidate_id: candidate.id,
    input_hash: inputHash,
    generator_version: generatorVersion,
    redaction_version: redactionVersion,
    generated_at: generatedAt,
    source_snapshot_refs: normalizeSnapshotRefs(sourceSnapshotRefs),
    display_summary: summarizeCandidate({
      displayName: candidate.display_name ?? candidate.displayName,
      currentTitle: profile.currentTitle ?? profile.seniority,
      currentCompany: profile.currentCompany ?? profile.industry,
      city: profile.location,
      experienceYears: profile.experienceYears,
    }),
    profile: buildProfile(profile),
    redacted_detail: {
      career_history: redactedDetail?.career_history ?? [],
      project_highlights: redactedDetail?.project_highlights ?? [],
    },
    redaction_report: {
      removed_categories: ["name", "phone", "email"],
      generalized_categories: ["company_name", "project_name", "client_name"],
      residual_pii_scan: "passed",
    },
  };

  const validated = await validateCandidateMatchProjection(doc);
  if (!validated.ok) {
    return { ok: false, errorCode: "MATCH_PROJECTION_SCHEMA_INVALID", errors: validated.errors };
  }
  return { ok: true, projection: doc, inputHash };
}

/**
 * 确定性残留 PII 扫描：命中任一规则返回类别列表（空 = 通过）。
 * 导出供测试直接校验。
 */
export function scanResidualPii({ profile, redactedDetail }) {
  const detected = [];
  const textParts = [
    ...(profile?.skills ?? []),
    profile?.location,
    profile?.industry,
    profile?.seniority,
    ...(redactedDetail?.career_history ?? []),
    ...(redactedDetail?.project_highlights ?? []),
  ]
    .filter(Boolean)
    .map(String);
  const joined = textParts.join("|");

  for (const rule of PII_PATTERNS) {
    if (rule.pattern.test(joined)) detected.push(rule.category);
  }
  return { detected };
}

function buildProfile(profile) {
  const expectedSalary = {
    minimum: profile.expectedSalaryMin ?? profile.expected_salary_min ?? null,
    maximum: profile.expectedSalaryMax ?? profile.expected_salary_max ?? null,
    period: "month",
    currency: "CNY",
  };
  return {
    skills: profile.skills ?? [],
    experience_years: profile.experienceYears ?? profile.experience_years ?? null,
    city: profile.location ?? null,
    education: mapEducation(profile.education),
    certificates: profile.certificates ?? [],
    seniority: profile.seniority ?? null,
    industry: profile.industry ?? null,
    expected_salary: expectedSalary,
    activity_updated_at: normalizeDate(profile.activityUpdatedAt ?? profile.activity_updated_at),
  };
}

function mapEducation(value) {
  if (!value) return null;
  return EDUCATION_ENUM[value] ?? null;
}

function normalizeCandidateInput({ candidate, profile, redactedDetail, generatorVersion, redactionVersion }) {
  return {
    generatorVersion,
    redactionVersion,
    candidate: {
      externalId: candidate.external_id ?? candidate.externalId ?? null,
      displayName: candidate.display_name ?? candidate.displayName ?? null,
    },
    profile: {
      skills: [...(profile?.skills ?? [])].sort(),
      experienceYears: profile?.experienceYears ?? profile?.experience_years ?? null,
      location: profile?.location ?? null,
      education: profile?.education ?? null,
      seniority: profile?.seniority ?? null,
      industry: profile?.industry ?? null,
      expectedSalaryMin: profile?.expectedSalaryMin ?? profile?.expected_salary_min ?? null,
      expectedSalaryMax: profile?.expectedSalaryMax ?? profile?.expected_salary_max ?? null,
      activityUpdatedAt: normalizeDate(profile?.activityUpdatedAt ?? profile?.activity_updated_at),
    },
    redactedDetail: {
      career_history: [...(redactedDetail?.career_history ?? [])].sort(),
      project_highlights: [...(redactedDetail?.project_highlights ?? [])].sort(),
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

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
