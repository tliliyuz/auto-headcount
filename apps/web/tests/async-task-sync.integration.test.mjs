import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { createAsyncTaskRepository } from "../lib/jobs/async-task-repository.mjs";
import {
  buildSyncIdempotencyKey,
  enqueueDueSyncTasks,
  runScheduledTick,
  syncPeriodKey,
} from "../lib/jobs/sync-scheduler.mjs";

const connectionString = process.env.DATABASE_URL;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function fakePage({ total, page, pageSize, totalPages, list }) {
  const payload = {
    Code: 0,
    Message: "success",
    Data: { total, page, page_size: pageSize, total_pages: totalPages, list },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fakeJob(externalId, ageDays) {
  return {
    job_id: externalId,
    job_title: `Job ${externalId}`,
    client_company: "Fixture Co",
    owner_id: "fixture-owner",
    owner_name: "Fixture Owner",
    days_without_rec: ageDays,
    last_rec_date: null,
    category: "Engineering",
    city: "Shanghai",
    salary_min: 20,
    salary_max: 30,
    portal_url: `https://portal.invalid/jobs/${externalId}`,
    created_at: null,
  };
}

function fixtureSource(marker) {
  return {
    provider: `fixture-sched-${marker}`,
    environment: "test",
    displayName: "Fixture Scheduled Sync",
  };
}

/**
 * 调度 tick 现同时入队 under_served 与 job_details 两种任务：
 * `wb.jobs.list` 走空页（job_details 平凡成功、不产生更新），其余工具交给被测 callTool。
 */
function dispatchCallTool(underServedCallTool) {
  return async (toolName, args) => {
    if (toolName === "wb.jobs.list") {
      return fakePage({
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        list: [],
      });
    }
    return underServedCallTool(toolName, args);
  };
}

function fixtureEnv(source, { withKey = true } = {}) {
  const env = {
    APP_ENV: "test",
    SYNC_SOURCE_PROVIDER: source.provider,
    SYNC_SOURCE_DISPLAY_NAME: source.displayName,
  };
  if (withKey) {
    env.APP_ENCRYPTION_KEY = ENC_KEY;
    env.APP_ENCRYPTION_KEY_VERSION = "test-v1";
  }
  return env;
}

/** 按 fixture source 清理 async_tasks / jobs / raw_records / sync_runs / source_connections / sync.run 审计。 */
async function cleanupFixture(sql, { source, taskIds }) {
  if (source) {
    await sql`
      delete from async_tasks
      where kind in ('under_served_sync', 'job_details_sync')
        and payload->'source'->>'provider' = ${source.provider}
    `;
    const sourceRows = await sql`
      select id from source_connections where provider = ${source.provider}
    `;
    for (const row of sourceRows) {
      await sql`delete from jobs where source_connection_id = ${row.id}`;
      await sql`delete from raw_records where source_connection_id = ${row.id}`;
      await sql`delete from sync_runs where source_connection_id = ${row.id}`;
      await sql`delete from source_connections where id = ${row.id}`;
    }
  }
  if (taskIds?.length) {
    await sql.begin(async (t) => {
      await t`set local app.audit_retention = 'on'`;
      await t`delete from audit_logs where action = 'sync.run' and request_id = any(${taskIds})`;
    });
  }
}

test(
  "调度 tick：enqueue→process 成功，任务 succeeded、职位入库、sync.run 审计",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];

    try {
      const callTool = dispatchCallTool(async () =>
        fakePage({
          total: 2,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          list: [fakeJob("s-7", 7), fakeJob("s-30", 30)],
        }),
      );

      const result = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      taskIds.push(result.taskId, result.detailsTaskId);
      assert.equal(result.enqueued, true);
      assert.equal(result.detailsEnqueued, true);
      assert.equal(result.succeeded, 2);
      assert.equal(result.retried, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.dead, 0);

      const [task] = await sql`
        select id, kind, status, attempts, finished_at, payload
        from async_tasks where id = ${result.taskId}
      `;
      assert.equal(task.kind, "under_served_sync");
      assert.equal(task.status, "succeeded");
      assert.equal(task.attempts, 1);
      assert.ok(task.finished_at !== null);
      assert.equal(task.payload.source.provider, source.provider);

      const [src] = await sql`
        select id from source_connections where provider = ${source.provider}
      `;
      const jobs = await sql`
        select external_id from jobs
        where source_connection_id = ${src.id} order by external_id
      `;
      assert.deepEqual(
        jobs.map((row) => row.external_id),
        ["s-30", "s-7"],
      );

      const [audit] = await sql`
        select actor_type, action, result, request_id, metadata
        from audit_logs where action = 'sync.run' and request_id = ${result.taskId}
      `;
      assert.equal(audit.actor_type, "system");
      assert.equal(audit.result, "success");
      assert.equal(audit.metadata.persisted, 2);
      assert.equal(audit.metadata.pages, 1);
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "网络错误（retryable）：任务回 pending + 退避，到期重跑成功",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];
    let calls = 0;

    try {
      const callTool = dispatchCallTool(async () => {
        calls += 1;
        if (calls === 1) {
          throw new McpDiscoveryError("rate limited", {
            code: "RATE_LIMITED",
            retryable: true,
          });
        }
        return fakePage({
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          list: [fakeJob("retry-7", 7)],
        });
      });

      const first = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      taskIds.push(first.taskId, first.detailsTaskId);
      assert.equal(first.retried, 1);

      const [afterFirst] = await sql`
        select status, attempts, next_attempt_at, last_error_code
        from async_tasks where id = ${first.taskId}
      `;
      assert.equal(afterFirst.status, "pending");
      assert.equal(afterFirst.attempts, 1);
      assert.equal(afterFirst.last_error_code, "RATE_LIMITED");
      assert.ok(afterFirst.next_attempt_at !== null);

      const retryNow = new Date(
        new Date(afterFirst.next_attempt_at).getTime() + 1000,
      );
      const second = await runScheduledTick({
        env,
        sql,
        now: retryNow,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      // job_details 已在首轮成功，重试轮仅 under_served 到期处理
      assert.equal(second.succeeded, 1);

      const [afterSecond] = await sql`
        select status, attempts from async_tasks where id = ${first.taskId}
      `;
      assert.equal(afterSecond.status, "succeeded");
      assert.equal(afterSecond.attempts, 2);
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "业务错误（非 retryable）：任务 failed、不重试",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];

    try {
      const callTool = dispatchCallTool(async () => {
        throw new McpDiscoveryError("contract drift", {
          code: "MCP_CONTRACT_ERROR",
        });
      });
      const result = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      taskIds.push(result.taskId, result.detailsTaskId);
      assert.equal(result.failed, 1);

      const [task] = await sql`
        select status, attempts, next_attempt_at, last_error_code
        from async_tasks where id = ${result.taskId}
      `;
      assert.equal(task.status, "failed");
      assert.equal(task.last_error_code, "MCP_CONTRACT_ERROR");
      assert.equal(task.next_attempt_at, null);
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "超过最大尝试次数：任务 dead",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];

    try {
      const callTool = dispatchCallTool(async () => {
        throw new McpDiscoveryError("timeout", {
          code: "MCP_TIMEOUT",
          retryable: true,
        });
      });
      const maxAttempts = 2;

      const t1 = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        maxAttempts,
        mcp: { callTool },
      });
      taskIds.push(t1.taskId, t1.detailsTaskId);
      assert.equal(t1.retried, 1);

      const [after1] = await sql`
        select attempts, next_attempt_at from async_tasks where id = ${t1.taskId}
      `;
      const t2 = await runScheduledTick({
        env,
        sql,
        now: new Date(new Date(after1.next_attempt_at).getTime() + 1000),
        intervalMs: SIX_HOURS_MS,
        maxAttempts,
        mcp: { callTool },
      });
      assert.equal(t2.dead, 1);

      const [after2] = await sql`
        select status, attempts, last_error_code
        from async_tasks where id = ${t1.taskId}
      `;
      assert.equal(after2.status, "dead");
      assert.equal(after2.attempts, 2);
      assert.equal(after2.last_error_code, "MCP_TIMEOUT");
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "幂等入队：同周期重复入队只产生一条任务",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const now = new Date();

    try {
      const first = await enqueueDueSyncTasks(sql, {
        source,
        now,
        intervalMs: SIX_HOURS_MS,
      });
      const second = await enqueueDueSyncTasks(sql, {
        source,
        now,
        intervalMs: SIX_HOURS_MS,
      });
      assert.equal(first.enqueued, true);
      assert.equal(second.enqueued, false);
      assert.equal(first.taskId, second.taskId);

      const [count] = await sql`
        select count(*)::int as n from async_tasks
        where idempotency_key = ${first.idempotencyKey}
      `;
      assert.equal(count.n, 1);

      const expectedKey = buildSyncIdempotencyKey(
        source.provider,
        syncPeriodKey(now, SIX_HOURS_MS),
      );
      assert.equal(first.idempotencyKey, expectedKey);
    } finally {
      await cleanupFixture(sql, { source, taskIds: [] });
      await sql.end();
    }
  },
);

test(
  "配置缺失（无加密 key）：任务 failed + ENCRYPTION_CONFIG_REQUIRED，不写 sync_runs",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source, { withKey: false });
    const now = new Date();
    const taskIds = [];

    try {
      const result = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool: async () => fakePage({ total: 1, page: 1, pageSize: 20, totalPages: 1, list: [] }) },
      });
      taskIds.push(result.taskId, result.detailsTaskId);
      assert.equal(result.failed, 1);

      const [task] = await sql`
        select status, last_error_code from async_tasks where id = ${result.taskId}
      `;
      assert.equal(task.status, "failed");
      assert.equal(task.last_error_code, "ENCRYPTION_CONFIG_REQUIRED");

      // under_served 缺加密配置失败不写 sync_run；job_details 不依赖加密，平凡成功属预期。
      const [runCount] = await sql`
        select count(*)::int as n from sync_runs
        where sync_type = 'under_served_jobs'
          and source_connection_id in (
            select id from source_connections where provider = ${source.provider}
          )
      `;
      assert.equal(runCount.n, 0);
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "手动同步去重：仅当无活跃任务时入队，活跃任务（pending/running）拦截新入队并返回既有任务",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const now = new Date();
    // 共享开发库可能已有真实 under_served_sync 活跃任务（不影响本测试语义：
    // 去重按 kind 作用域生效），故用 marker 隔离的 fixture kind。
    const kind = `fixture-manual-sync:${marker}`;
    const prefix = `under-served-sync:manual:${marker}`;
    const keys = {
      a: `${prefix}-a`,
      b: `${prefix}-b`,
      c: `${prefix}-c`,
      d: `${prefix}-d`,
    };
    try {
      const taskRepo = createAsyncTaskRepository(sql);

      // 1) 空闲时首次入队成功
      const firstId = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: keys.a,
        payload: {},
        scheduledAt: now,
      });
      assert.ok(firstId, "空闲时应入队成功");

      // 2) 已有 pending 活跃任务时，新入队被拦截（不同 key 不重复入队）
      const blocked = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: keys.b,
        payload: {},
        scheduledAt: now,
      });
      assert.equal(blocked, null, "存在活跃任务时应拦截新入队");

      // 3) findActiveTask 返回当前活跃任务（最早入队者）
      const active = await taskRepo.findActiveTask({ kind });
      assert.ok(active, "应能查到活跃任务");
      assert.equal(active.id, firstId);
      assert.ok(["pending", "running"].includes(active.status));

      // 4) 活跃任务进入终态后，可再次入队
      await taskRepo.finishTask({
        id: firstId,
        status: "succeeded",
        finishedAt: now,
      });
      const afterId = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: keys.b,
        payload: {},
        scheduledAt: now,
      });
      assert.ok(afterId, "活跃任务结束后应可再次入队");
      assert.notEqual(afterId, firstId);

      // 5) running 状态同样拦截（认领后仍在执行）
      await sql`
        update async_tasks set status = 'running', started_at = ${now}
        where id = ${afterId}
      `;
      const blockedByRunning = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: keys.c,
        payload: {},
        scheduledAt: now,
      });
      assert.equal(blockedByRunning, null, "running 任务同样拦截新入队");
      const activeWhileRunning = await taskRepo.findActiveTask({ kind });
      assert.equal(activeWhileRunning.id, afterId);
    } finally {
      await sql`
        delete from async_tasks where idempotency_key like ${`${prefix}%`}
      `;
      await sql.end();
    }
  },
);

test(
  "任务看门狗：崩溃残留 running 任务回收为 failed + TASK_STALE_TIMEOUT，去重守卫随之释放",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const kind = `fixture-stale-sync:${marker}`;
    const now = new Date();
    const prefix = `under-served-sync:manual:${marker}`;
    let taskId;
    try {
      const taskRepo = createAsyncTaskRepository(sql);

      // 1) 入队并模拟进程崩溃：认领为 running 且 started_at 远早于 now
      taskId = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: `${prefix}-stale`,
        payload: {},
        scheduledAt: now,
      });
      await sql`
        update async_tasks
        set status = 'running', started_at = ${new Date(now.getTime() - 60 * 60 * 1000)}
        where id = ${taskId}
      `;

      // 2) 看门狗：过期 running → failed + TASK_STALE_TIMEOUT + finished_at
      const reclaimed = await taskRepo.failStaleRunningTasks({
        staleBefore: new Date(now.getTime() - 30 * 60 * 1000),
      });
      assert.equal(reclaimed, 1);
      const [after] = await sql`
        select status, last_error_code, finished_at
        from async_tasks where id = ${taskId}
      `;
      assert.equal(after.status, "failed");
      assert.equal(after.last_error_code, "TASK_STALE_TIMEOUT");
      assert.ok(after.finished_at !== null);

      // 3) 去重守卫释放：卡死任务被回收后，新入队不再被拦截
      const freshId = await taskRepo.enqueueTaskIfIdle({
        kind,
        idempotencyKey: `${prefix}-fresh`,
        payload: {},
        scheduledAt: now,
      });
      assert.ok(freshId, "看门狗回收后应可再次入队");
    } finally {
      await sql`
        delete from async_tasks where idempotency_key like ${`${prefix}%`}
      `;
      await sql.end();
    }
  },
);

test(
  "调度 tick 看门狗：回收崩溃残留 running 任务并正常处理本周期新任务（staleReclaimed）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];
    // 共享开发库可能已有真实 under_served_sync 卡死任务（看门狗全局回收，会一并计数），
    // 故本 fixture 用 marker 隔离的 kind，且对回收数断言用 >= 而不断言精确值。
    const staleKind = `fixture-stale-tick:${marker}`;
    const staleKey = `under-served-sync:manual:${marker}-stale`;

    try {
      // 造一个卡死 running 的任务（started_at 早于 30 分钟阈值）
      const taskRepo = createAsyncTaskRepository(sql);
      const staleTaskId = await taskRepo.enqueueTaskIfIdle({
        kind: staleKind,
        idempotencyKey: staleKey,
        payload: {},
        scheduledAt: now,
      });
      await sql`
        update async_tasks set status = 'running',
          started_at = ${new Date(now.getTime() - 60 * 60 * 1000)}
        where id = ${staleTaskId}
      `;

      const callTool = dispatchCallTool(async () =>
        fakePage({
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          list: [fakeJob("w-7", 7)],
        }),
      );
      const result = await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });

      // 看门狗至少回收本 fixture 卡死任务；本周期新入队任务正常成功
      assert.ok(result.staleReclaimed >= 1, "应回收卡死 running 任务");
      assert.equal(result.enqueued, true);
      assert.ok(result.succeeded >= 1, "本周期新任务应成功");
      const [stale] = await sql`
        select status, last_error_code from async_tasks where id = ${staleTaskId}
      `;
      assert.equal(stale.status, "failed");
      assert.equal(stale.last_error_code, "TASK_STALE_TIMEOUT");

      taskIds.push(result.taskId, result.detailsTaskId);
      await sql`delete from async_tasks where idempotency_key = ${staleKey}`;
    } finally {
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);
