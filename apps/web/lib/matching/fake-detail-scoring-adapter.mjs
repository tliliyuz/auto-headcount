const DIMENSIONS = ["skills", "industry", "seniority", "experience", "location", "salary", "activity"];

export const FAKE_DETAIL_SCORING_METADATA = Object.freeze({
  adapterId: "fake-detail-scoring",
  adapterVersion: "1",
  modelId: "fake-detail-v1",
  modelRevision: "fixture-1",
  promptVersion: "detail-score/prompt-v1",
  schemaVersion: "llm-detail-score/v1",
});

export function createFakeDetailScoringAdapter() {
  return {
    metadata: FAKE_DETAIL_SCORING_METADATA,
    async score(input) {
      const job = input.jobProjection ?? {};
      const candidate = input.candidateProjection ?? {};
      const profile = candidate.profile ?? {};
      const detail = candidate.redactedDetail ?? {};
      const history = Array.isArray(detail.career_history) ? detail.career_history : [];
      const dimensions = [
        scoreSkills(job, profile),
        scoreTextDimension("industry", job.scoring_context?.industry, [profile.industry, ...history]),
        scoreTextDimension("seniority", job.scoring_context?.seniority, [profile.seniority, ...history]),
        scoreExperience(job, profile, history),
        scoreTextDimension("location", job.hard_requirements?.locations?.[0], [profile.city]),
        scoreSalary(job, profile),
        scoreActivity(profile),
      ];
      return {
        schema_version: FAKE_DETAIL_SCORING_METADATA.schemaVersion,
        request_item_id: normalizeRequestItemId(input.requestItemId),
        dimensions: DIMENSIONS.map((dimension) => dimensions.find((item) => item.dimension === dimension)),
        missing_items: dimensions.filter((item) => !item.assessable).map((item) => `${item.dimension} 信息不足`),
        risks: [],
        overall_confidence: round(dimensions.reduce((sum, item) => sum + item.confidence, 0) / DIMENSIONS.length),
      };
    },
  };
}

function scoreSkills(job, profile) {
  const required = strings(job.hard_requirements?.required_skills);
  const actual = strings(profile.skills);
  if (required.length === 0 || actual.length === 0) return unavailable("skills");
  const hits = required.filter((skill) => actual.some((value) => normalized(value).includes(normalized(skill))));
  return available("skills", Math.round(60 + 40 * hits.length / required.length), actual.join("、"), required.join("、"), `命中 ${hits.length}/${required.length} 项必备技能`);
}

function scoreTextDimension(dimension, requirement, facts) {
  const actual = strings(facts);
  if (!requirement || actual.length === 0) return unavailable(dimension);
  const hit = actual.some((value) => normalized(value).includes(normalized(requirement)) || normalized(requirement).includes(normalized(value)));
  return available(dimension, hit ? 90 : 65, actual.join("、"), String(requirement), hit ? "存在直接相关经历" : "存在可迁移经历但缺少直接证据");
}

function scoreExperience(job, profile, history) {
  const years = number(profile.experience_years);
  const minimum = number(job.hard_requirements?.min_experience_years);
  if (years === null && history.length === 0) return unavailable("experience");
  const actualYears = years ?? round(history.reduce((sum, item) => sum + (number(item.duration_months) ?? 0), 0) / 12);
  const score = minimum === null ? 80 : Math.max(50, Math.min(100, Math.round(70 + 10 * (actualYears - minimum))));
  return available("experience", score, `${actualYears} 年相关经历`, minimum === null ? "综合经历" : `至少 ${minimum} 年`, "按脱敏履历年限评估");
}

function scoreSalary(job, profile) {
  const range = job.hard_requirements?.salary;
  const expected = profile.expected_salary;
  if (!range || !expected) return unavailable("salary");
  const expectedMinimum = number(expected.minimum);
  const expectedMaximum = number(expected.maximum);
  const jobMinimum = number(range.minimum);
  const jobMaximum = number(range.maximum);
  if ([expectedMinimum, expectedMaximum, jobMinimum, jobMaximum].some((value) => value === null)) return unavailable("salary");
  const compatible = expectedMinimum <= jobMaximum && expectedMaximum >= jobMinimum;
  return available("salary", compatible ? 90 : 55, `${expected.minimum}-${expected.maximum}`, `${range.minimum}-${range.maximum}`, compatible ? "薪资区间重叠" : "薪资区间无重叠");
}

function scoreActivity(profile) {
  const activity = profile.activity_updated_at;
  if (!activity) return unavailable("activity");
  return available("activity", 80, String(activity), "近期保持求职活跃", "存在脱敏活跃度信号");
}

function available(dimension, score, fact, requirement, assessment) {
  return {
    dimension, assessable: true, score: Math.max(0, Math.min(100, Math.round(score))),
    evidence: [{ candidate_fact: clipped(fact), job_requirement: clipped(requirement), assessment: clipped(assessment) }],
    confidence: 0.8,
  };
}

function unavailable(dimension) {
  return { dimension, assessable: false, score: null, evidence: [], confidence: 0 };
}

function strings(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).filter(Boolean).map(String);
}
function normalized(value) { return String(value).trim().toLowerCase(); }
function number(value) { if (value === null || value === undefined || value === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function round(value) { return Math.round(value * 100) / 100; }
function clipped(value) { return String(value || "未提供").slice(0, 500); }
function normalizeRequestItemId(value) {
  const normalizedValue = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return normalizedValue.length >= 16 ? normalizedValue : `${normalizedValue}_fixture_00000000`.slice(0, 100);
}
