import type postgres from "postgres";

export interface AsyncTaskRepoRow {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  scheduledAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastErrorCode: string | null;
  nextAttemptAt: Date | null;
}

export interface AsyncTaskRepository {
  enqueueTask(input: {
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    scheduledAt: Date;
  }): Promise<string | null>;
  claimDueTasks(input: {
    limit?: number;
    now: Date;
  }): Promise<
    Array<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number }>
  >;
  finishTask(input: {
    id: string;
    status: "succeeded" | "failed" | "dead";
    errorCode?: string | null;
    finishedAt?: Date | null;
  }): Promise<void>;
  markPendingForRetry(input: {
    id: string;
    nextAttemptAt: Date;
    errorCode?: string | null;
  }): Promise<void>;
}

export declare function createAsyncTaskRepository(
  sql: postgres.Sql,
): AsyncTaskRepository;
