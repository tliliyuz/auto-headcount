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
    operabilityStatus?: string | null;
  },
): Promise<{ rawRecordId: string; jobId: string }>;

/** 关闭本次完整拉取未见的陈旧沉睡职位（seen 含不可操作，不误标 not_in_access_scope）。 */
export function closeStaleUnderServedJobs(
  sql: SqlClient,
  input: { sourceId: string; seenExternalIds: string[] },
): Promise<number>;

/** 批量标记本地可操作状态（如 seen 但不可操作 → not_in_access_scope）。 */
export function markOperabilityStatus(
  sql: SqlClient,
  input: { sourceId: string; externalIds: string[]; status: string },
): Promise<number>;

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
