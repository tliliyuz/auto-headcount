import type postgres from "postgres";

type SqlClient = postgres.Sql;

export type UnderServedSyncMcp = {
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  actorId?: string;
};

export type UnderServedSyncSource = {
  provider: string;
  environment: "development" | "test" | "production";
  displayName: string;
};

export type UnderServedSyncOutcome =
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
      stats: Record<string, number | string | null>;
    };

export function runUnderServedSync(input: {
  sql: SqlClient;
  encryption: { key: string; keyVersion: string };
  source: UnderServedSyncSource;
  pageSize?: number;
  maxPages?: number;
  daysWithoutRec?: number;
  mcp?: UnderServedSyncMcp;
}): Promise<UnderServedSyncOutcome>;
