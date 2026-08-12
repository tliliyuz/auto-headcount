import postgres from "postgres";

type SqlClient = postgres.Sql;

export type PageResult<T> = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: T[];
};

export type SourceView = {
  id: string;
  provider: string;
  environment: string;
  status: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
  lastRunId: string | null;
  lastRunSyncType: string | null;
  lastRunStatus: string | null;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  lastRunErrorCode: string | null;
  lastRunStats: Record<string, number> | null;
};

export type SyncRunView = {
  id: string;
  sourceConnectionId: string;
  sourceDisplayName: string;
  sourceProvider: string;
  syncType: string;
  status: string;
  stats: Record<string, number>;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export function listSources(
  sql: SqlClient,
  input?: { page?: number; pageSize?: number },
): Promise<PageResult<SourceView>>;

export function listSyncRuns(
  sql: SqlClient,
  input?: { status?: string; page?: number; pageSize?: number },
): Promise<PageResult<SyncRunView>>;
