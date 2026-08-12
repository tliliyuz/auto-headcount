export type JobStatus = "active" | "paused" | "closed";

export interface UnderServedJobInput {
  ageDays: number;
  status: JobStatus;
  recommendationCount: number;
}

export interface PublicJobInput {
  title: string;
  companyName: string;
  companyAlias?: string;
  city: string;
  detailedLocation?: string;
  salaryMin?: number;
  salaryMax?: number;
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
