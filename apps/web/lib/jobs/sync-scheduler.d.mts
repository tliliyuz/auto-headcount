import type postgres from "postgres";

export type TaskDecision = "succeeded" | "retry" | "failed" | "dead";

export interface SyncSourceConfig {
  provider: string;
  environment: string;
  displayName: string;
}

export interface SyncTickResult {
  enqueued: boolean;
  taskId: string | null;
  idempotencyKey: string;
  detailsEnqueued: boolean;
  detailsTaskId: string | null;
  detailsIdempotencyKey: string;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  dead: number;
}

export declare function syncPeriodKey(now: Date, intervalMs: number): number;
export declare function buildSyncIdempotencyKey(
  provider: string,
  periodKey: number,
): string;
export declare function nextRetryDelayMs(
  attempts: number,
  baseMs?: number,
  maxMs?: number,
): number;
export declare function decideTaskOutcome(input: {
  status: string;
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
}): TaskDecision;

export declare function enqueueDueSyncTasks(
  sql: postgres.Sql,
  input: {
    source: SyncSourceConfig;
    now: Date;
    intervalMs?: number;
  },
): Promise<{ enqueued: boolean; taskId: string | null; idempotencyKey: string }>;

export declare function enqueueJobDetailSyncTasks(
  sql: postgres.Sql,
  input: {
    source: SyncSourceConfig;
    now: Date;
    intervalMs?: number;
  },
): Promise<{ enqueuedDetails: boolean; taskId: string | null; idempotencyKey: string }>;

export declare function processDueTasks(
  sql: postgres.Sql,
  input: {
    env: Record<string, unknown>;
    now: Date;
    maxAttempts?: number;
    mcp?: { callTool: (tool: string, args: object) => Promise<unknown> };
  },
): Promise<{
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  dead: number;
}>;

export declare function runScheduledTick(input: {
  env: Record<string, unknown>;
  sql: postgres.Sql;
  now?: Date;
  intervalMs?: number;
  maxAttempts?: number;
  mcp?: { callTool: (tool: string, args: object) => Promise<unknown> };
}): Promise<SyncTickResult>;
