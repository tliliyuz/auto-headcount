import postgres from "postgres";

type SqlClient = postgres.Sql;

export type PageResult<T> = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: T[];
};

export type CandidateRow = {
  id: string;
  externalId: string;
  name: string;
  summary: string | null;
  consentStatus: string;
  title: string | null;
  company: string | null;
  city: string | null;
  experienceYears: number | null;
  education: string | null;
  school: string | null;
  major: string | null;
  seniority: string | null;
  industry: string | null;
  activityUpdatedAt: Date | null;
  createdAt: Date;
  matchCount: number;
  status: string;
};

export function listCandidates(
  sql: SqlClient,
  input?: { q?: string; status?: string; page?: number; pageSize?: number },
): Promise<PageResult<CandidateRow>>;

export type CandidateDetailRow = CandidateRow & {
  skills: string[];
  workExperiences: Array<{
    company: string | null;
    title: string | null;
    city: string | null;
    period: string | null;
    duration: string | null;
    description: string | null;
  }>;
  projects: Array<{ name: string | null; description: string | null }>;
  educationHistory: Array<{
    school: string | null;
    major: string | null;
    degree: string | null;
    period: string | null;
    duration: string | null;
  }>;
};

export function getCandidateById(
  sql: SqlClient,
  id: string,
  options: { encryption: { key: string; keyVersion: string } },
): Promise<CandidateDetailRow | undefined>;
