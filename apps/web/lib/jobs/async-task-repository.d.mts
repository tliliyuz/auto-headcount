import type postgres from "postgres";

import type { BrowserJobCollectTaskPayload } from "./browser-job-collection.mjs";

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
  /** 手动触发守卫：仅当同 kind 无活跃（pending/running）任务时原子入队；被拦截返回 null。 */
  enqueueTaskIfIdle(input: {
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    scheduledAt: Date;
  }): Promise<string | null>;
  /** 返回同 kind 当前活跃任务（pending/running），按入队序取最早；无则 null。 */
  findActiveTask(input: { kind: string }): Promise<{ id: string; status: string } | null>;
  /** 任务看门狗：回收 started_at 早于 staleBefore 的 running 任务为 failed + errorCode，返回回收数。 */
  failStaleRunningTasks(input: {
    staleBefore: Date;
    errorCode?: string;
  }): Promise<number>;
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
  /** 浏览器职位目标去重：同目标（source/user/device/contract/externalId）无活跃任务时原子入队；被拦截返回 null。 */
  enqueueBrowserJobTaskIfTargetIdle(input: {
    idempotencyKey: string;
    payload: BrowserJobCollectTaskPayload;
    scheduledAt: Date;
  }): Promise<string | null>;
  /** 返回同浏览器职位目标当前活跃任务（pending/running）；无则 null。 */
  findActiveBrowserJobTask(
    payload: BrowserJobCollectTaskPayload,
  ): Promise<{ id: string; status: string } | null>;
}

export declare function createAsyncTaskRepository(
  sql: postgres.Sql,
): AsyncTaskRepository;
