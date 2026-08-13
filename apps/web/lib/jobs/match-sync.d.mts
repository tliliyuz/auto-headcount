import type postgres from "postgres";

type SqlClient = postgres.Sql;

export const MATCH_CANDIDATES_TOOL: "wb.jobs.match_candidates";
export const MATCH_LOCAL_SYNC_TYPE: "match_local_jobs";

export type MatchSyncMcp = {
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  actorId?: string;
};

export type MatchSyncSource = {
  provider: string;
  environment: "development" | "test" | "production";
  displayName: string;
};

export type MatchSyncOutcome =
  | {
      status: "succeeded";
      syncRunId: string;
      sourceId: string;
      stats: Record<string, number>;
    }
  | {
      status: "failed";
      syncRunId: string;
      sourceId: string;
      errorCode: string;
      retryable: boolean;
      stats: Record<string, number | string | null>;
    };

export function runMatchSync(input: {
  sql: SqlClient;
  source: MatchSyncSource;
  jobIds: string[];
  ruleVersion?: number;
  batchSize?: number;
  staleSyncRunMs?: number;
  mcp?: MatchSyncMcp;
}): Promise<MatchSyncOutcome>;

export function createMatchCallTool(options?: {
  actorId?: string;
  env?: Record<string, unknown>;
}): (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
