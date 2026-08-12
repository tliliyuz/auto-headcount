export function isUnderServedJob(job) {
  return (
    job.ageDays >= 7 &&
    job.ageDays <= 30 &&
    job.status === "active" &&
    job.recommendationCount === 0
  );
}

export function classifyMatch(score) {
  if (score >= 85) return "high";
  if (score >= 75) return "medium";
  return "low";
}

export function toPublicJobView(job) {
  const hasSalaryRange =
    Number.isFinite(job.salaryMin) &&
    Number.isFinite(job.salaryMax) &&
    job.salaryMin > 0 &&
    job.salaryMax >= job.salaryMin;

  return {
    title: job.title,
    city: job.city,
    salaryRange: hasSalaryRange
      ? `${job.salaryMin}–${job.salaryMax}`
      : "薪资面议",
    companyLabel: "某科技企业",
  };
}
