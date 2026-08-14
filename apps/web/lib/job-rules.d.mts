export type JobStatus = "active" | "paused" | "closed";

export interface UnderServedJobInput {
  ageDays: number;
  /** 规则只比较 `=== "active"`，接受客户端视图的宽字符串（列表仅含 active，防御性不收紧）。 */
  status: string;
  recommendationCount: number;
}

export interface PublicJobInput {
  title: string;
  companyName: string;
  companyAlias?: string;
  city: string;
  detailedLocation?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
}

export interface PublicJobView {
  title: string;
  city: string;
  salaryRange: string;
  companyLabel: string;
}

export function isUnderServedJob(job: UnderServedJobInput): boolean;
export function classifyMatch(score: number): "high" | "medium" | "low";
export function toPublicJobView(job: PublicJobInput): PublicJobView;
