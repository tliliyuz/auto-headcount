/**
 * 第一阶段确定性硬过滤（docs/10 §5、docs/01 §1.3）。
 *
 * 纯函数、无 LLM、无副作用：输入为职位要求投影 + 候选人脱敏匹配投影 + 过滤规则版本，
 * 输出通过/剔除原因。同投影哈希 + 同规则版本 → 同结果（确定性可复算）。
 *
 * 原因码（稳定机器码，docs/10 §5）：
 * - LOCATION_MISMATCH           城市不再硬过滤（全国招人/候选人可换城市，城市交阶段二评分维度）；机器码保留供契约/历史引用
 * - REQUIRED_SKILL_MISSING      零命中必备技能（候选人不匹配任何必备技能；命中 ≥1 即通过技能门槛）
 * - EXPERIENCE_BELOW_MINIMUM    最低年限不足
 * - EDUCATION_BELOW_MINIMUM     学历层级不足
 * - CERTIFICATE_MISSING         必备证书缺失
 * - SALARY_NO_OVERLAP           薪资硬约束且无交集
 * - REQUIRED_FIELD_MISSING      职位关键硬要求缺失（默认不过，进异常/人工补全队列）
 *
 * 未通过 → 不创建 LLM 评分运行（docs/10 §5）。
 */

import { createHash } from "node:crypto";

export const FILTER_REASON_CODES = {
  LOCATION_MISMATCH: "LOCATION_MISMATCH",
  REQUIRED_SKILL_MISSING: "REQUIRED_SKILL_MISSING",
  EXPERIENCE_BELOW_MINIMUM: "EXPERIENCE_BELOW_MINIMUM",
  EDUCATION_BELOW_MINIMUM: "EDUCATION_BELOW_MINIMUM",
  CERTIFICATE_MISSING: "CERTIFICATE_MISSING",
  SALARY_NO_OVERLAP: "SALARY_NO_OVERLAP",
  REQUIRED_FIELD_MISSING: "REQUIRED_FIELD_MISSING",
};

/** 学历层级（契约枚举，低→高）。 */
const EDUCATION_ORDER = [
  "none",
  "high_school",
  "associate",
  "bachelor",
  "master",
  "doctorate",
];

/**
 * 确定性硬过滤。
 * @param {object} input
 * @param {object} input.jobProjection - 职位要求投影文档
 * @param {object} input.candidateProjection - 候选人脱敏匹配投影文档
 * @param {string} [input.filterRuleVersion] - 规则版本（默认 v1）
 * @returns {{passed:boolean, reasonCodes:Array<{code:string,jobValue:string,candidateValue:string,explanation:string}>, combinedInputHash:string}}
 */
export function hardFilter({
  jobProjection,
  candidateProjection,
  filterRuleVersion = "v1",
}) {
  const hard = jobProjection.hard_requirements ?? {};
  const profile = candidateProjection.profile ?? {};
  const reasonCodes = [];

  // 关键硬要求缺失 → 默认不过（docs/10 §5 REQUIRED_FIELD_MISSING）
  if (!Array.isArray(hard.required_skills) || hard.required_skills.length === 0) {
    reasonCodes.push(reason("REQUIRED_FIELD_MISSING", "必备技能", "未指定/缺失", "职位未指定必备技能清单"));
  }

  // 必备技能：命中 ≥1 项必备技能即通过技能门槛（部分匹配交阶段二 LLM 评分维度评估，
  // docs/10 §5 2026-08-16 规则 v3）；零命中 → REQUIRED_SKILL_MISSING。比较做大小写/空白归一化。
  // 城市不再作为硬门槛：全国招人 + 候选人可换城市，城市匹配交由阶段二 `location` 评分维度
  // 评估（LOCATION_MISMATCH 不再由硬过滤发出；LOCATION_MISMATCH 机器码保留供契约/历史引用）。
  const requiredSkills = hard.required_skills ?? [];
  const candSkills = new Set((profile.skills ?? []).map(normalizeSkill));
  const matchedSkills = requiredSkills.filter((s) => candSkills.has(normalizeSkill(s)));
  if (requiredSkills.length > 0 && matchedSkills.length === 0) {
    reasonCodes.push(
      reason(
        "REQUIRED_SKILL_MISSING",
        requiredSkills.join("、"),
        (profile.skills ?? []).join("、") || "未指定",
        `候选人未命中任何必备技能：${requiredSkills.join("、")}`,
      ),
    );
  }

  // 最低年限
  const minYears = hard.min_experience_years;
  if (typeof minYears === "number" && minYears > 0) {
    const candYears = profile.experience_years;
    if (typeof candYears !== "number" || candYears < minYears) {
      reasonCodes.push(
        reason(
          "EXPERIENCE_BELOW_MINIMUM",
          `≥${minYears} 年`,
          candYears == null ? "未知" : `${candYears} 年`,
          `要求最低 ${minYears} 年经验，候选人${candYears == null ? "未提供" : `仅 ${candYears} 年`}`,
        ),
      );
    }
  }

  // 学历
  const eduMin = hard.education_min;
  if (eduMin && educationRank(eduMin) > 0) {
    const candEdu = profile.education;
    if (educationRank(candEdu) < educationRank(eduMin)) {
      reasonCodes.push(
        reason(
          "EDUCATION_BELOW_MINIMUM",
          eduMin,
          candEdu ?? "未知",
          `要求学历不低于 ${eduMin}，候选人学历 ${candEdu ?? "未知"}`,
        ),
      );
    }
  }

  // 证书
  const requiredCerts = hard.required_certificates ?? [];
  const candCerts = new Set(profile.certificates ?? []);
  const missingCerts = requiredCerts.filter((c) => !candCerts.has(c));
  if (missingCerts.length > 0) {
    reasonCodes.push(
      reason(
        "CERTIFICATE_MISSING",
        requiredCerts.join("、"),
        [...candCerts].join("、") || "未指定",
        `候选人缺少必备证书：${missingCerts.join("、")}`,
      ),
    );
  }

  // 薪资：硬约束且双方都有边界 → 无交集不过；非硬约束或缺失 → 软性（不触发）
  if (hard.salary?.hard_constraint === true) {
    const salaryMiss = checkSalaryOverlap(hard.salary, profile.expected_salary);
    if (salaryMiss) reasonCodes.push(salaryMiss);
  }

  const combinedInputHash = createHash("sha256")
    .update(
      JSON.stringify({
        filterRuleVersion,
        jobProjectionHash: jobProjection.input_hash ?? jobProjection.projection_id,
        candidateProjectionHash: candidateProjection.input_hash ?? candidateProjection.projection_id,
      }),
    )
    .digest("hex");

  return { passed: reasonCodes.length === 0, reasonCodes, combinedInputHash };
}

function reason(code, jobValue, candidateValue, explanation) {
  return { code, jobValue, candidateValue, explanation };
}

function normalizeSkill(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** 薪资硬约束且区间无交集 → 返回原因（否则 null）。 */
function checkSalaryOverlap(jobSalary, candSalary) {
  const jMin = jobSalary?.minimum;
  const jMax = jobSalary?.maximum;
  const cMin = candSalary?.minimum;
  const cMax = candSalary?.maximum;
  const hasAll = [jMin, jMax, cMin, cMax].every((v) => typeof v === "number");
  if (!hasAll) return null; // 边界缺失 → 软性处理，不硬过滤
  if (cMax < jMin || cMin > jMax) {
    return reason(
      "SALARY_NO_OVERLAP",
      `${jMin}-${jMax}`,
      `${cMin}-${cMax}`,
      `期望薪资 ${cMin}-${cMax} 与职位 ${jMin}-${jMax} 无交集（硬约束）`,
    );
  }
  return null;
}

function educationRank(edu) {
  if (!edu) return -1; // 未知 → 不因缺失而判不足（缺失由 REQUIRED_FIELD_MISSING 语义处理）
  const idx = EDUCATION_ORDER.indexOf(edu);
  return idx === -1 ? -1 : idx;
}
