/**
 * 落地页脱敏白名单 DTO（docs/03 §10、docs/07 §3 切片）：
 * 只含职位标题/类别/城市/薪资范围，**永不**包含公司名称/简称、内部职位编号、客户联系人、
 * 招聘负责人、详细地址或原始 JD。原始 JD 截断可能泄漏内嵌公司/品牌名（如岗位背景首句），
 * 因此职责摘要在运营侧配好去标识化摘要前一律省略（白名单为「最多包含」，省略即合规）。
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
  };
}
