import postgres from "postgres";

type SqlClient = postgres.Sql;

export type PageResult<T> = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: T[];
};

export type UnderServedJobRow = {
  id: string;
  externalId: string;
  mappingVersion: string;
  title: string;
  companyName: string;
  category: string;
  city: string;
  detailedLocation: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  status: string;
  ageDays: number;
  recommendationCount: number;
  sourceConnectionId: string;
  rawRecordId: string | null;
  publishedAt: Date | null;
  sourceUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  hasDescription: boolean;
};

export function listUnderServedJobs(
  sql: SqlClient,
  input?: { category?: string; q?: string; page?: number; pageSize?: number },
): Promise<PageResult<UnderServedJobRow>>;

export type JobDetailRow = UnderServedJobRow & {
  jobDescription: string | null;
};

export function getJobById(
  sql: SqlClient,
  id: string,
): Promise<JobDetailRow | undefined>;
