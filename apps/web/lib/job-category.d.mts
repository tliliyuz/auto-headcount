export type JobCategoryBucket =
  | "技术研发"
  | "产品设计"
  | "市场销售"
  | "数据智能"
  | "其他";

export const JOB_CATEGORY_BUCKETS: JobCategoryBucket[];

export function mapJobCategory(
  category: string | null | undefined,
): JobCategoryBucket;
