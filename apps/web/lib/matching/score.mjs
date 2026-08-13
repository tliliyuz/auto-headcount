/**
 * 本地确定性评分引擎（ADR-005 主匹配路径；docs/01 §1.3）。
 *
 * 纯函数、无外部依赖、可复算：同一规则版本 + 同一规范化输入 → 完全相同的维度分/总分。
 * 硬过滤（地点/技能/年限/学历 中的非妥协项）+ 7 维加权评分（技能/行业/职级/经历/地点/薪资/活跃度）。
 * 供应方 match_candidates 仅作外部对照（external_* 字段），不参与本地权威分。
 */

import { createHash } from "node:crypto";
import { classifyMatch } from "../job-rules.mjs";

/** 默认 7 维权重（version 1，可复算可调——改版本即可）。 */
export const DEFAULT_WEIGHTS = {
  技能: 0.25,
  经历: 0.2,
  职级: 0.15,
  地点: 0.15,
  薪资: 0.1,
  行业: 0.1,
  活跃度: 0.05,
};

/** 默认阈值（version 1）：分带 85/75；硬过滤经历下限 0。 */
export const DEFAULT_THRESHOLDS = {
  high: 85,
  medium: 75,
  min_experience_years: 0,
};

/** 缺失数据时维度的中性分（不因数据缺失拉低/拉高，可复算）。 */
const NEUTRAL = 50;

/**
 * 硬过滤：地点（同城或未指定）、关键技能（必须全部具备）、年限（≥ 要求）、学历（≥ 要求）。
 * 不过 → 该 (职位, 候选人) 不入匹配池。`missing` 为不可妥协的缺失说明。
 */
export function hardFilter({ jobRequirements = {}, candidateProfile = {} }) {
  const missing = [];
  const reqSkills = jobRequirements.skills ?? [];
  const candSkills = candidateProfile.skills ?? [];
  const missingSkills = reqSkills.filter((s) => !candSkills.includes(s));
  if (missingSkills.length > 0) {
    missing.push(`缺少关键技能：${missingSkills.join("、")}`);
  }

  const minYears =
    jobRequirements.min_experience_years ?? DEFAULT_THRESHOLDS.min_experience_years;
  const candYears = candidateProfile.experienceYears ?? 0;
  if (minYears > 0 && candYears < minYears) {
    missing.push(`经历不足：需 ≥${minYears} 年，实际 ${candYears} 年`);
  }

  if (jobRequirements.education && !educationSatisfies(candidateProfile.education, jobRequirements.education)) {
    missing.push(`学历不满足：需 ${jobRequirements.education}，实际 ${candidateProfile.education ?? "未知"}`);
  }

  // 地点硬过滤：仅当职位明确限定城市且候选人明确其他城市时视为不过
  // （候选人可异地，属软性维度；硬性限定由 job_requirements.constraints 表达，见 dimensionScores 地点维）。
  return { passed: missing.length === 0, missing };
}

/**
 * 7 维加权评分：每维 0-100（缺失数据用中性 50），附带命中证据/风险提示。
 * 顺序固定（技能/行业/职级/经历/地点/薪资/活跃度），保证可复算。
 */
export function dimensionScores({ jobRequirements = {}, candidateProfile = {} }) {
  const reqSkills = jobRequirements.skills ?? [];
  const candSkills = candidateProfile.skills ?? [];

  // 技能：覆盖率 = 命中数 / 要求数（无要求 → 中性）
  const skillScore =
    reqSkills.length === 0
      ? NEUTRAL
      : Math.round((100 * reqSkills.filter((s) => candSkills.includes(s)).length) / reqSkills.length);
  const skillHit =
    reqSkills.length === 0
      ? "职位未指定关键技能"
      : `技能命中：${reqSkills.filter((s) => candSkills.includes(s)).join("、") || "无"}`;

  // 行业：候选人行业 vs 职位类别（jobRequirements.industry ?? 默认中性）
  const reqIndustry = jobRequirements.industry ?? null;
  const candIndustry = candidateProfile.industry ?? null;
  const industryScore =
    reqIndustry && candIndustry
      ? (candIndustry === reqIndustry ? 100 : relatedIndustry(reqIndustry, candIndustry) ? 70 : 40)
      : NEUTRAL;

  // 职级：候选人职级 vs 职位职级（同/相邻/不同）
  const reqSeniority = jobRequirements.seniority ?? null;
  const candSeniority = candidateProfile.seniority ?? null;
  const seniorityScore =
    reqSeniority && candSeniority
      ? (candSeniority === reqSeniority ? 100 : adjacentSeniority(reqSeniority, candSeniority) ? 70 : 40)
      : NEUTRAL;

  // 经历：候选人年限 vs 职位要求
  const minYears = jobRequirements.min_experience_years ?? 0;
  const candYears = candidateProfile.experienceYears ?? null;
  const experienceScore =
    candYears === null || candYears === undefined
      ? NEUTRAL
      : candYears >= minYears
        ? 100
        : candYears >= minYears * 0.7
          ? 70
          : 40;

  // 地点：候选人城市 vs 职位城市
  const reqCity = jobRequirements.location ?? null;
  const candCity = candidateProfile.location ?? null;
  const locationScore =
    reqCity && candCity
      ? (candCity === reqCity ? 100 : sameRegion(candCity, reqCity) ? 70 : 30)
      : NEUTRAL;

  // 薪资：候选人期望薪资 vs 职位薪资范围（null → 中性）
  const salaryScore = salaryDimensionScore(jobRequirements, candidateProfile);

  // 活跃度：画像最近更新（30/90/180 天）
  const activityScore = activityDimensionScore(candidateProfile.activityUpdatedAt);

  return [
    { dimension: "技能", score: skillScore, evidence: skillHit, risk: null },
    { dimension: "行业", score: industryScore, evidence: candIndustry ? `候选人行业：${candIndustry}` : "行业信息缺失", risk: industryScore === NEUTRAL ? "行业信息缺失，按中性处理" : null },
    { dimension: "职级", score: seniorityScore, evidence: candSeniority ? `候选人职级：${candSeniority}` : "职级信息缺失", risk: seniorityScore === NEUTRAL ? "职级信息缺失，按中性处理" : null },
    { dimension: "经历", score: experienceScore, evidence: candYears !== null ? `候选人经历：${candYears} 年` : "经历信息缺失", risk: experienceScore === NEUTRAL ? "经历信息缺失，按中性处理" : null },
    { dimension: "地点", score: locationScore, evidence: candCity ? `候选人城市：${candCity}` : "地点信息缺失", risk: locationScore === NEUTRAL ? "地点信息缺失，按中性处理" : null },
    { dimension: "薪资", score: salaryScore.score, evidence: salaryScore.evidence, risk: salaryScore.risk },
    { dimension: "活跃度", score: activityScore.score, evidence: activityScore.evidence, risk: activityScore.risk },
  ];
}

/** 加权总分 + 分带 + 证据/缺失/风险 + 输入哈希（可复算）。 */
export function scoreMatch({
  jobRequirements,
  candidateProfile,
  weights = DEFAULT_WEIGHTS,
  thresholds = DEFAULT_THRESHOLDS,
  ruleVersion = 1,
}) {
  const inputHash = computeInputHash({ jobRequirements, candidateProfile, weights, thresholds, ruleVersion });
  const filter = hardFilter({ jobRequirements, candidateProfile });
  if (!filter.passed) {
    return {
      passed: false,
      totalScore: null,
      band: null,
      dimensions: [],
      evidence: [],
      missing: filter.missing,
      risk: [],
      inputHash,
    };
  }

  const dimensions = dimensionScores({ jobRequirements, candidateProfile });
  const totalScore = Math.round(
    dimensions.reduce((sum, d) => sum + d.score * (weights[d.dimension] ?? 0), 0),
  );
  const band = classifyMatch(totalScore);
  return {
    passed: true,
    totalScore,
    band,
    dimensions,
    evidence: dimensions.map((d) => d.evidence).filter(Boolean),
    missing: dimensions
      .filter((d) => d.score === NEUTRAL)
      .map((d) => `${d.dimension}信息缺失`),
    risk: dimensions.map((d) => d.risk).filter(Boolean),
    inputHash,
  };
}

/** 规范化输入 → SHA-256 前 16 字节 hex；同规则版本同输入同哈希（docs/01 §1.3 可复算）。 */
export function computeInputHash({
  jobRequirements,
  candidateProfile,
  weights = DEFAULT_WEIGHTS,
  thresholds = DEFAULT_THRESHOLDS,
  ruleVersion,
}) {
  const canonical = JSON.stringify({
    ruleVersion,
    weights,
    thresholds,
    job: normalizeJobInput(jobRequirements),
    candidate: normalizeCandidateInput(candidateProfile),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function normalizeJobInput(jobRequirements) {
  return {
    skills: [...(jobRequirements?.skills ?? [])].sort(),
    seniority: jobRequirements?.seniority ?? null,
    education: jobRequirements?.education ?? null,
    salaryMin: jobRequirements?.salaryMin ?? null,
    salaryMax: jobRequirements?.salaryMax ?? null,
    location: jobRequirements?.location ?? null,
    industry: jobRequirements?.industry ?? null,
    min_experience_years: jobRequirements?.min_experience_years ?? 0,
  };
}

function normalizeCandidateInput(candidateProfile) {
  return {
    skills: [...(candidateProfile?.skills ?? [])].sort(),
    experienceYears: candidateProfile?.experienceYears ?? null,
    location: candidateProfile?.location ?? null,
    education: candidateProfile?.education ?? null,
    seniority: candidateProfile?.seniority ?? null,
    industry: candidateProfile?.industry ?? null,
    expectedSalaryMin: candidateProfile?.expectedSalaryMin ?? null,
    expectedSalaryMax: candidateProfile?.expectedSalaryMax ?? null,
    activityUpdatedAt: candidateProfile?.activityUpdatedAt ?? null,
  };
}

const EDUCATION_ORDER = ["高中", "大专", "本科", "硕士", "博士"];

/** 学历是否满足要求（按常见层级序）。 */
function educationSatisfies(candidateEducation, requiredEducation) {
  if (!candidateEducation) return false;
  const c = EDUCATION_ORDER.indexOf(candidateEducation);
  const r = EDUCATION_ORDER.indexOf(requiredEducation);
  if (c === -1 || r === -1) return candidateEducation === requiredEducation;
  return c >= r;
}

const REGION_MAP = {
  北京: "华北",
  天津: "华北",
  上海: "华东",
  南京: "华东",
  杭州: "华东",
  苏州: "华东",
  深圳: "华南",
  广州: "华南",
  成都: "西南",
  重庆: "西南",
  武汉: "华中",
  长沙: "华中",
  西安: "西北",
};

function sameRegion(cityA, cityB) {
  const a = REGION_MAP[cityA];
  const b = REGION_MAP[cityB];
  return !!a && a === b;
}

/** 行业相近（简单同词根/包含判断，确定性）。 */
function relatedIndustry(reqIndustry, candIndustry) {
  if (!reqIndustry || !candIndustry) return false;
  return candIndustry.includes(reqIndustry) || reqIndustry.includes(candIndustry);
}

/** 职级相邻（简单字符串前缀/层级序）。 */
function adjacentSeniority(req, cand) {
  const order = ["初级", "中级", "高级", "资深", "专家", "总监"];
  const ri = order.indexOf(req);
  const ci = order.indexOf(cand);
  if (ri === -1 || ci === -1) return false;
  return Math.abs(ri - ci) === 1;
}

function salaryDimensionScore(jobRequirements, candidateProfile) {
  const reqMin = jobRequirements.salaryMin ?? null;
  const reqMax = jobRequirements.salaryMax ?? null;
  const candMin = candidateProfile.expectedSalaryMin ?? null;
  const candMax = candidateProfile.expectedSalaryMax ?? null;
  if (reqMin === null || reqMax === null || candMin === null || candMax === null) {
    return { score: NEUTRAL, evidence: "薪资信息缺失", risk: "薪资信息缺失，按中性处理" };
  }
  if (candMin >= reqMin && candMax <= reqMax) {
    return { score: 100, evidence: `期望薪资 ${candMin}-${candMax} 在职位 ${reqMin}-${reqMax} 内`, risk: null };
  }
  if (candMax >= reqMin && candMin <= reqMax) {
    return { score: 70, evidence: `期望薪资 ${candMin}-${candMax} 与职位 ${reqMin}-${reqMax} 有交集`, risk: null };
  }
  return { score: 30, evidence: `期望薪资 ${candMin}-${candMax} 超出职位 ${reqMin}-${reqMax}`, risk: "薪资期望可能偏高/偏低" };
}

function activityDimensionScore(activityUpdatedAt) {
  if (!activityUpdatedAt) {
    return { score: NEUTRAL, evidence: "活跃度信息缺失", risk: "活跃度信息缺失，按中性处理" };
  }
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(activityUpdatedAt).getTime()) / 86400000),
  );
  if (days <= 30) return { score: 100, evidence: `画像 ${days} 天前更新`, risk: null };
  if (days <= 90) return { score: 70, evidence: `画像 ${days} 天前更新`, risk: "活跃度一般" };
  if (days <= 180) return { score: 40, evidence: `画像 ${days} 天前更新`, risk: "画像较旧，可能已离职" };
  return { score: 20, evidence: `画像 ${days} 天前更新`, risk: "画像久未更新" };
}
