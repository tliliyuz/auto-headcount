import type postgres from "postgres";

import type { SyncSourceConfig } from "./sync-scheduler.mjs";

export const BROWSER_JOB_JD_BACKFILL_TASK_KIND: "browser_job_jd_backfill";
export const BROWSER_JOB_JD_BACKFILL_SYNC_TYPE: "browser_job_jd_backfill";
export const DEFAULT_BACKFILL_LIMIT: 50;

export class BrowserJobJdBackfillError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export interface BrowserJobJdBackfillTaskPayload {
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: string;
  externalId: string;
  jobId: string;
  expectedTitle?: string;
}

export function parseBrowserJobJdBackfillTaskPayload(
  input: unknown,
): BrowserJobJdBackfillTaskPayload;

export function runBrowserJobJdBackfill(input: {
  task: unknown;
  now?: Date;
  relayClient: unknown;
  repository: unknown;
}): Promise<Record<string, unknown>>;

export function enqueueBrowserJobJdBackfillTasks(input: {
  sql: postgres.Sql;
  source: SyncSourceConfig;
  userId: string;
  deviceId: string;
  limit?: number;
}): Promise<{
  scanned: number;
  enqueued: number;
  skipped: string[];
  sourceId: string;
}>;
