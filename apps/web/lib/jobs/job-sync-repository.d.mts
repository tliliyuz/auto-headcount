import type { UnderServedJobSourceRecord } from "../adapters/mcp-under-served-contract.mjs";
import postgres from "postgres";

type SqlClient = postgres.Sql;

export function getOrCreateSourceConnection(
  sql: SqlClient,
  input: { provider: string; environment: string; displayName: string },
): Promise<string>;

export function startSyncRun(
  sql: SqlClient,
  sourceId: string,
  syncType: string,
): Promise<string>;

export function persistUnderServedJob(
  sql: SqlClient,
  input: {
    sourceId: string;
    syncRunId: string;
    rawPayload: unknown;
    job: UnderServedJobSourceRecord;
    encryption: { key: string; keyVersion: string };
  },
): Promise<{ rawRecordId: string; jobId: string }>;

export function finishSyncRun(
  sql: SqlClient,
  syncRunId: string,
  stats: Record<string, number>,
): Promise<void>;

export function updateJobDescriptions(
  sql: SqlClient,
  input: {
    sourceId: string;
    rows: { externalId: string; jobDescription: string | null }[];
  },
): Promise<{ matched: number; present: number; total: number }>;

export function failSyncRun(
  sql: SqlClient,
  syncRunId: string,
  errorCode: string,
  stats?: Record<string, number | string | null>,
): Promise<void>;
