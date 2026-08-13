import type postgres from "postgres";

type SqlClient = postgres.Sql;

export const PROJECTION_FILTER_SYNC_TYPE: "match_projection_filter";
export const DEFAULT_FILTER_RULE_VERSION: "v1";
export const DEFAULT_GENERATOR_VERSION: "rules/v1";
export const DEFAULT_REDACTION_VERSION: "redact/v1";

export type ProjectionFilterStats = {
  jobsQueried: number;
  jobsProjected: number;
  candidatesQueried: number;
  candidatesProjected: number;
  piiRejected: number;
  filterPassed: number;
  filterRejected: number;
  failed: number;
};

export type ProjectionFilterOutcome =
  | { status: "succeeded"; syncRunId: string; sourceId: string; stats: ProjectionFilterStats }
  | {
      status: "failed";
      syncRunId: string;
      sourceId: string;
      errorCode: string;
      retryable: boolean;
      stats: ProjectionFilterStats & { errorCode?: string };
    };

export function runProjectionFilterSync(input: {
  sql: SqlClient;
  source: { provider: string; environment: string; displayName: string };
  jobIds?: string[];
  filterRuleVersion?: string;
  generatorVersion?: string;
  redactionVersion?: string;
  candidateRedactedDetails?: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>;
  encryption: { key: string; keyVersion: string };
  staleSyncRunMs?: number;
  now?: () => Date;
}): Promise<ProjectionFilterOutcome>;
