import { jobCoarseBucket } from "../job-category.mjs";
import { inferJobSummary } from "./landing-summary.mjs";

/** 月薪范围 → k 展示（源 salary_min/max 为月薪元，用户口径 2026-08-15）。脏值（>100 万/月）与异常边界降级为「薪资面议」，不推断（docs/07 §3）。 */
export function formatMonthlySalaryK(salaryMin, salaryMax) {
  const MIN_VALID = 1000; // 至少 1k/月
  const MAX_VALID = 1_000_000; // 超过 100 万/月视为源脏数据
  const ok =
    Number.isInteger(salaryMin) &&
    Number.isInteger(salaryMax) &&
    salaryMin >= MIN_VALID &&
    salaryMax >= salaryMin &&
    salaryMax <= MAX_VALID;
  if (!ok) return "薪资面议";
  const k = (value) => `${Math.round(value / 1000)}k`;
  return `¥${k(salaryMin)}–${k(salaryMax)}`;
}

/**
 * 落地页脱敏白名单 DTO（docs/03 §10、docs/07 §3 切片）：
 * 只含职位标题/类别（运营粗桶，5 类白名单）/城市/月薪范围(k)/去标识化职责摘要，**永不**包含公司名称/简称、内部职位编号、
 * 客户联系人、招聘负责人、详细地址或原始 JD。职责摘要由模板 + 白名单词库自动生成
 * （结构性去标识化，见 landing-summary.mjs）。年包/薪资结构（14薪+期权+绩效）MCP 无此字段，
 * 属未来浏览器采集数据缺口（见 docs/03 §10 注记）。
 */

/** AI 匹配评价白名单维度标签（docs/03 §8、docs/07 §3 P5）：只展示标签与数字分，evidence/风险/事实原文绝不进入 DTO。 */
export const MATCH_DIMENSION_LABELS = Object.freeze({
  skills: "技能匹配",
  industry: "行业背景",
  seniority: "职级经验",
  experience: "经验年限",
  location: "城市匹配",
  salary: "薪资预期",
  activity: "活跃度",
});

/** AI 匹配评价 band 白名单（聚合规则 aggregation/v1，docs/10 §5）。 */
export const MATCH_BAND_LABELS = Object.freeze({
  high: "高度匹配",
  medium: "匹配",
  low: "需进一步了解",
});

const MATCH_DIMENSION_LABEL_ORDER = Object.values(MATCH_DIMENSION_LABELS);

/**
 * 已审核匹配 → 候选人对内展示的 AI 匹配评价（docs/07 §3 P5）：只投影总分、band 白名单标签、
 * 白名单维度标签 + 数字分；evidence/risk/assessable/事实原文一律剔除（结构性去标识化，与职责摘要同源）。
 * 无可展示维度或无匹配 → null。
 */
export function toAiEvaluation(match) {
  if (!match) return null;
  const dimensions = (match.dimensions ?? [])
    .filter(
      (d) =>
        d.assessable !== false &&
        MATCH_DIMENSION_LABELS[d.dimension] &&
        Number.isFinite(d.score),
    )
    .map((d) => ({ label: MATCH_DIMENSION_LABELS[d.dimension], score: Math.round(d.score) }))
    .sort(
      (a, b) =>
        MATCH_DIMENSION_LABEL_ORDER.indexOf(a.label) -
        MATCH_DIMENSION_LABEL_ORDER.indexOf(b.label),
    );
  if (dimensions.length === 0) return null;
  return {
    score: Number.isFinite(match.score) ? Math.round(match.score) : null,
    bandLabel: MATCH_BAND_LABELS[match.band] ?? null,
    dimensions,
  };
}
export function toMaskedJobView(job) {
  return {
    title: job.title,
    // 岗位大类 tag 取运营粗桶（5 类白名单，docs/03 §10）：源 category 非空且可映射时权威优先，
    // 为空/未映射时按标题推断（job-category.mjs 的 jobCoarseBucket）；绝不输出源 category 原始值。
    category: jobCoarseBucket(job.category, job.title),
    city: job.city,
    salaryRange: formatMonthlySalaryK(job.salaryMin, job.salaryMax),
    summary: inferJobSummary({
      category: job.category,
      title: job.title,
      jobDescription: job.jobDescription,
    }),
  };
}
