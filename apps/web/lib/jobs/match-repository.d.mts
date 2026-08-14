import type postgres from "postgres";

type SqlClient = postgres.Sql;

export function upsertCandidate(
  sql: SqlClient,
  input: {
    externalId: string;
    displayName: string;
    summary: string | null;
  },
): Promise<string>;

export function upsertMatch(
  sql: SqlClient,
  input: {
    jobId: string;
    candidateId: string;
    score: number | null;
    band: string | null;
    status?: string;
    ruleVersion: number;
    scoreStatus?: string;
    inputHash?: string | null;
    evidence?: string[];
    missing?: string[];
    risk?: string[];
    jobProjectionId?: string | null;
    candidateProjectionId?: string | null;
    filterResultId?: string | null;
    llmScoreRunId?: string | null;
    aggregationRuleVersion?: string | null;
  },
): Promise<{ id: string; status: string }>;

/** 外部对照更新：把供应方 match_candidates 结果写入匹配 external_*（非权威分）。 */
export function updateMatchExternalReference(
  sql: SqlClient,
  input: {
    jobId: string;
    externalCandidateId: string;
    externalScore: number | null;
    externalTier: string | null;
    externalScoreStatus: string | null;
    ruleVersion: number;
  },
): Promise<void>;

export function replaceMatchDimensions(
  sql: SqlClient,
  input: {
    matchId: string;
    dimensions:
      | { dimension: string; score: number | null; evidence?: string | null; risk?: string | null; assessable?: boolean | null; confidence?: number | null; llmScoreRunId?: string | null; outputHash?: string | null }[]
      | null;
  },
): Promise<number>;
