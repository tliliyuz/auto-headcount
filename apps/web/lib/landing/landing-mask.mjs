import { inferJobSummary } from "./landing-summary.mjs";

/**
 * 落地页脱敏白名单 DTO（docs/03 §10、docs/07 §3 切片）：
 * 只含职位标题/类别/城市/薪资范围/去标识化职责摘要，**永不**包含公司名称/简称、内部职位编号、
 * 客户联系人、招聘负责人、详细地址或原始 JD。职责摘要由模板 + 白名单词库自动生成
 * （结构性去标识化，见 landing-summary.mjs）。
 */
export function toMaskedJobView(job) {
  const hasSalaryRange =
    Number.isFinite(job.salaryMin) &&
    Number.isFinite(job.salaryMax) &&
    job.salaryMin > 0 &&
    job.salaryMax >= job.salaryMin;

  return {
    title: job.title,
    category: job.category,
    city: job.city,
    // 薪资只展示上下限范围；边界缺失时安全降级文案，不推断精确薪资。
    salaryRange: hasSalaryRange ? `${job.salaryMin}–${job.salaryMax}` : "薪资面议",
    summary: inferJobSummary({
      category: job.category,
      title: job.title,
      jobDescription: job.jobDescription,
    }),
  };
}
