import type postgres from "postgres";

type SqlClient = postgres.Sql;

export const JOBS_GET_TOOL: "wb.jobs.get";
export const JOB_DETAILS_SYNC_TYPE: "job_details_jobs";

export type JobDetailsSyncMcp = {
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  actorId?: string;
};

export type JobDetailsSyncSource = {
  provider: string;
  environment: "development" | "test" | "production";
  displayName: string;
};

export type JobDetailsSyncOutcome =
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

export function runJobDetailsSync(input: {
  sql: SqlClient;
  source: JobDetailsSyncSource;
  staleSyncRunMs?: number;
  mcp?: JobDetailsSyncMcp;
}): Promise<JobDetailsSyncOutcome>;
