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
 * 只含职位标题/类别/城市/月薪范围(k)/去标识化职责摘要，**永不**包含公司名称/简称、内部职位编号、
 * 客户联系人、招聘负责人、详细地址或原始 JD。职责摘要由模板 + 白名单词库自动生成
 * （结构性去标识化，见 landing-summary.mjs）。年包/薪资结构（14薪+期权+绩效）MCP 无此字段，
 * 属未来浏览器采集数据缺口（见 docs/03 §10 注记）。
 */
export function toMaskedJobView(job) {
  return {
    title: job.title,
    category: job.category,
    city: job.city,
    salaryRange: formatMonthlySalaryK(job.salaryMin, job.salaryMax),
    summary: inferJobSummary({
      category: job.category,
      title: job.title,
      jobDescription: job.jobDescription,
    }),
  };
}
