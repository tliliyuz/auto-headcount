import type postgres from "postgres";

type SqlClient = postgres.Sql;

export type MatchView = {
  id: string;
  jobId: string;
  jobTitle: string;
  jobExternalId: string;
  candidateId: string;
  candidateName: string | null;
  candidateSummary: string | null;
  score: number | null;
  band: string | null;
  status: string;
  /** 迁移 0016：superseded 标记（旧版被新 match 取代，工作台默认不显示，可审计）。 */
  isSuperseded: boolean;
  ruleVersion: number;
  scoreStatus: string;
  evidence: string[];
  missing: string[];
  risk: string[];
  createdAt: string;
  updatedAt: string;
};

export type MatchDimensionView = {
  dimension: string;
  score: number | null;
  evidence: string | null;
  risk: string | null;
};

export type MatchDetailView = MatchView & {
  sourceUpdatedAt: string | null;
  dimensions: MatchDimensionView[];
};

export function listMatches(
  sql: SqlClient,
  input?: {
    jobId?: string;
    band?: string;
    status?: string;
    /** 迁移 0016：true 返回 superseded 旧行（审计），默认 false 只展示 active。 */
    includeSuperseded?: boolean;
    page?: number;
    pageSize?: number;
  },
): Promise<{
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: MatchView[];
}>;

export function getMatchById(
  sql: SqlClient,
  id: string,
): Promise<MatchDetailView | undefined>;
