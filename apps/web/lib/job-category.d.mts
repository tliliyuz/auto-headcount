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

/** 按职位标题关键词推断粗桶（源不提供 category 时的回退方案，启发式非权威）。 */
export function inferCoarseBucketFromTitle(
  title: string | null | undefined,
): JobCategoryBucket;

/** 取职位运营粗桶：源 category 非空且可映射时优先（权威），否则回退标题推断。 */
export function jobCoarseBucket(
  category: string | null | undefined,
  title: string | null | undefined,
): JobCategoryBucket;
