/**
 * 摘要服务（docs/01 §1.2）：职位/候选人摘要 ≤150 中文字符，不含联系方式与直接身份标识。
 * 本地确定性生成（模板/截断），不调用 LLM（M2 退出门禁 docs/05:188）。
 */

const MAX_LENGTH = 150;

/** 职位摘要：标题 + 类别/城市/薪资（可选）。 */
export function summarizeJob(job) {
  if (!job) return "";
  const parts = [job.title ?? ""].filter(Boolean);
  const meta = [job.category, job.city].filter(Boolean);
  if (meta.length) parts.push(`（${meta.join(" · ")}）`);
  if (job.salaryMin != null || job.salaryMax != null) {
    parts.push(`薪资 ${job.salaryMin ?? "?"}-${job.salaryMax ?? "?"}`);
  }
  return truncate(parts.join(" "));
}

/** 候选人摘要：打码名 + 现职/公司/城市/经历（无联系方式）。 */
export function summarizeCandidate(candidate) {
  if (!candidate) return "";
  const parts = [];
  if (candidate.displayName) parts.push(candidate.displayName);
  const meta = [candidate.currentTitle, candidate.currentCompany].filter(Boolean);
  if (meta.length) parts.push(meta.join(" · "));
  if (candidate.city) parts.push(candidate.city);
  if (typeof candidate.experienceYears === "number") {
    parts.push(`${candidate.experienceYears} 年经验`);
  }
  return truncate(parts.join("，"));
}

function truncate(text) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > MAX_LENGTH
    ? `${normalized.slice(0, MAX_LENGTH - 1)}…`
    : normalized;
}
