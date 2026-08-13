import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { createAsyncTaskRepository } from "../lib/jobs/async-task-repository.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import {
  buildSyncIdempotencyKey,
  enqueueDueSyncTasks,
  processDueTasks,
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
 * 调度 tick 现同时入队 under_served 与 job_details 两种任务（fix4）：
 * - `wb.jobs.list` → 可操作集（operableIds，供 under_served 同步只入库可操作∩沉睡）；
 * - `wb.jobs.get` → 返回单职位 JD（供 job-details 同步补全，DB 驱动）；
 * 其余工具交给被测 callTool。
 */
function dispatchCallTool(underServedCallTool, { operableIds = [] } = {}) {
  return async (toolName, args) => {
    if (toolName === "wb.jobs.list") {
      return fakePage({
        total: operableIds.length,
        page: 1,
        pageSize: 100,
        totalPages: operableIds.length ? 1 : 0,
        list: operableIds.map((id) => ({
          job_id: id,
          job_title: `Job ${id}`,
          status: "active",
          job_description: `JD ${id}`,
        })),
      });
    }
    if (toolName === "wb.jobs.get") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              Code: 0,
              Message: "success",
              Data: {
                job_id: args.job_id,
                job_title: `Job ${args.job_id}`,
                status: "active",
                job_description: `JD ${args.job_id}`,
              },
            }),
          },
        ],
      };
    }
    if (toolName === "wb.jobs.match_candidates") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              Code: 0,
              Message: "success",
              Data: {
                source_id: args.job_id,
                source_type: "job",
                total: 1,
                page: 1,
                page_size: 20,
                total_pages: 1,
                matches: [
                  {
                    candidate_id: "cand-x",
                    is_own: true,
                    owner_id: "o-1",
                    owner_name: "示例顾问",
                    score_status: "cached",
                    total_score: 80,
                    tier: "moderate",
                    dimension_scores: null,
                    match_highlights: [],
                    gap_analysis: [],
                    risk_flags: [],
                    verification_suggestions: [],
                    job_summary: null,
                    candidate_summary: {
                      candidate_id: "cand-x",
                      name: "王**",
                      current_title: "算法工程师",
                      current_company: "示例公司",
                      city: "上海",
                      experience_years: 5,
                      resume_summary: "示例公司-算法工程师",
                    },
                  },
                ],
              },
            }),
          },
        ],
      };
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

/**
 * 测试槽位重置：串行化后（fix3）同 kind 同时只跑一个，共享开发库里 docker scheduler
 * 正在跑的 under_served_sync/job_details_sync 会挡住测试新入队的同 kind 任务。
 * tick 类测试开始时先回收这些真实在途任务（标 failed + TEST_SLATE_RESET），使测试可确定执行。
 */
async function reclaimRunningSyncTasks(sql) {
  await sql`
    update async_tasks
    set status = 'failed', last_error_code = 'TEST_SLATE_RESET',
        finished_at = now(), updated_at = now()
    where kind in ('under_served_sync', 'job_details_sync', 'match_candidates_sync', 'browser_job_collect')
      and status = 'running'
  `;
}

/** 按 fixture source 清理 async_tasks / jobs / raw_records / sync_runs / source_connections / sync.run 审计。 */
async function cleanupFixture(sql, { source, taskIds }) {
  if (source) {
    await sql`
      delete from async_tasks
      where kind in ('under_served_sync', 'job_details_sync', 'match_candidates_sync')
        and payload->'source'->>'provider' = ${source.provider}
    `;
    const sourceRows = await sql`
      select id from source_connections where provider = ${source.provider}
    `;
    for (const row of sourceRows) {
      // FK 顺序：先删本源 matches（match_dimensions 级联）→ candidates → job_requirements → jobs
      const referenced = await sql`
        select distinct m.candidate_id as id
        from matches m join jobs j on j.id = m.job_id
        where j.source_connection_id = ${row.id}
      `;
      await sql`delete from matches where job_id in (select id from jobs where source_connection_id = ${row.id})`;
      if (referenced.length) {
        await sql`delete from candidate_profiles where candidate_id = any(${referenced.map((r) => r.id)})`;
        await sql`delete from candidates where id = any(${referenced.map((r) => r.id)})`;
      }
      await sql`delete from job_requirements where job_id in (select id from jobs where source_connection_id = ${row.id})`;
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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);

    try {
      const callTool = dispatchCallTool(
        async () =>
          fakePage({
            total: 2,
            page: 1,
            pageSize: 20,
            totalPages: 1,
            list: [fakeJob("s-7", 7), fakeJob("s-30", 30)],
          }),
        { operableIds: ["s-7", "s-30"] },
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
  "browser_job_collect：预检、固定提取、规则校验与事务入库，重跑职位幂等",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const now = new Date("2026-08-13T09:00:00.000Z");
    const taskIds = [];
    let sourceId;
    await reclaimRunningSyncTasks(sql);
    const relay = {
      async getConnectionStatus() {
        return { status: "READY", ready: true };
      },
      async extractJobDetail({ expectedExternalId }) {
        return {
          contractId: "liebide-job-detail-v1",
          contractVersion: 1,
          sourceOrigin: "https://portal.liebide.com",
          capturedAt: now.toISOString(),
          contentHash: "b".repeat(64),
          externalId: expectedExternalId,
          title: "Fixture Browser Job",
          status: "active",
          city: "上海",
          salaryMin: 20000,
          salaryMax: 30000,
          jobDescription: "完全虚构的浏览器采集职位详情。",
          publishedAt: "2026-08-04T09:00:00.000Z",
          validRecommendationCount: 0,
        };
      },
    };
    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const repo = createAsyncTaskRepository(sql);
      const payload = {
        sourceConnectionId: sourceId,
        userId: "fixture-user",
        deviceId: "fixture-device",
        contractId: "liebide-job-detail-v1",
        externalId: `browser-${marker}`,
      };
      for (let index = 0; index < 2; index += 1) {
        const taskId = await repo.enqueueBrowserJobTaskIfTargetIdle({
          idempotencyKey: `browser-job-collect:test:${marker}:${index}`,
          payload,
          scheduledAt: now,
        });
        taskIds.push(taskId);
        if (index === 0) {
          const duplicate = await repo.enqueueBrowserJobTaskIfTargetIdle({
            idempotencyKey: `browser-job-collect:test:${marker}:duplicate`,
            payload,
            scheduledAt: now,
          });
          assert.equal(duplicate, null, "同目标活跃任务必须去重");
          assert.equal((await repo.findActiveBrowserJobTask(payload)).id, taskId);
        }
        const summary = await processDueTasks(sql, {
          env: { APP_ENCRYPTION_KEY: ENC_KEY, APP_ENCRYPTION_KEY_VERSION: "test-v1" },
          now,
          browserRelay: relay,
        });
        assert.equal(summary.succeeded, 1);
      }
      const [counts] = await sql`
        select
          (select count(*)::int from jobs where source_connection_id = ${sourceId}) as jobs,
          (select count(*)::int from raw_records where source_connection_id = ${sourceId}) as raws
      `;
      assert.deepEqual({ jobs: counts.jobs, raws: counts.raws }, { jobs: 1, raws: 2 });
      const [saved] = await sql`
        select mapping_version, job_description, days_without_recommendation,
               valid_recommendation_count, operability_status
        from jobs where source_connection_id = ${sourceId}
      `;
      assert.deepEqual(saved, {
        mapping_version: "browser-job-v1",
        job_description: "完全虚构的浏览器采集职位详情。",
        days_without_recommendation: 9,
        valid_recommendation_count: 0,
        operability_status: "actionable",
      });
    } finally {
      await sql`delete from async_tasks where id = any(${taskIds.filter(Boolean)})`;
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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);
    let calls = 0;

    try {
      const callTool = dispatchCallTool(
        async () => {
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
        },
        { operableIds: ["retry-7"] },
      );

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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);

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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);

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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);

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
    // 清空共享库里真实 scheduler 在途的 under_served/job_details 任务，确保测试可确定认领
    await reclaimRunningSyncTasks(sql);
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

      const callTool = dispatchCallTool(
        async () =>
          fakePage({
            total: 1,
            page: 1,
            pageSize: 20,
            totalPages: 1,
            list: [fakeJob("w-7", 7)],
          }),
        { operableIds: ["w-7"] },
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

test(
  "串行化认领：同 kind 至多认领一个、running 时不再认领同 kind、不同 kind 各认领一个",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const kindA = `fixture-serial-a:${marker}`;
    const kindB = `fixture-serial-b:${marker}`;
    // 认领用 now；fixture 调度到 epoch 起递增（最早且确定顺序），确保在共享库真实任务之前排序
    const now = new Date();
    const ids = [];

    try {
      const taskRepo = createAsyncTaskRepository(sql);
      // 2 个同 kind A + 1 个 kind B，全部到期 pending；a1 严格早于 a2（同 scheduled_at 会退化为 id 决胜）
      const schedule = { a1: new Date(0), a2: new Date(1), b1: new Date(0) };
      for (const [kind, suffix] of [[kindA, "a1"], [kindA, "a2"], [kindB, "b1"]]) {
        const id = await taskRepo.enqueueTask({
          kind,
          idempotencyKey: `serial:${marker}:${suffix}`,
          payload: {},
          scheduledAt: schedule[suffix],
        });
        ids.push({ id, kind });
      }

      // 1) 首次认领：每 kind 至多认领最早一个 → A=a1 + B=b1，a2 不认领
      const first = await taskRepo.claimDueTasks({ limit: 10, now });
      assert.ok(first.some((t) => t.id === ids[0].id), "a1 被认领");
      assert.ok(first.some((t) => t.id === ids[2].id), "b1 被认领");
      assert.ok(!first.some((t) => t.id === ids[1].id), "同 kind 至多认领一个（a2 不被认领）");
      assert.equal(
        first.filter((t) => t.kind === kindA).length,
        1,
        "kind A 只认领一条",
      );

      // 2) A/B 均 running → a2 不再被认领
      const second = await taskRepo.claimDueTasks({ limit: 10, now });
      assert.ok(!second.some((t) => t.id === ids[1].id), "kind 已有 running 时不认领 a2");

      // 3) A 结束 running → a2 被认领（B 仍 running 不影响 A）
      await taskRepo.finishTask({ id: ids[0].id, status: "succeeded", finishedAt: now });
      const third = await taskRepo.claimDueTasks({ limit: 10, now });
      assert.ok(third.some((t) => t.id === ids[1].id), "A 释放后 a2 被认领");
    } finally {
      await sql`
        delete from async_tasks where idempotency_key like ${`serial:${marker}%`}
      `;
      await sql.end();
    }
  },
);

test(
  "调度分发：match_candidates_sync 任务被认领执行并落库匹配",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];
    await reclaimRunningSyncTasks(sql);

    try {
      // seed 一个可操作职位
      const sourceId = await getOrCreateSourceConnection(sql, source);
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      const { jobId } = await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: runId,
        rawPayload: { job_id: "m-1" },
        job: {
          externalId: "m-1",
          title: "Match Job",
          companyName: "Fixture Co",
          ownerExternalId: "fixture-owner",
          ownerName: "Fixture Owner",
          ageDays: 9,
          lastRecommendationAt: null,
          category: "Engineering",
          city: "Shanghai",
          salaryMin: 20,
          salaryMax: 30,
          portalUrl: "https://portal.invalid/jobs/m-1",
          sourceCreatedAt: null,
          eligibilityEvidence: {
            activeStatus: "provider_filter",
            zeroRecommendations: "provider_filter",
            age: "days_without_rec",
          },
        },
        encryption: { key: ENC_KEY, keyVersion: "test-v1" },
        operabilityStatus: "actionable",
      });
      await finishSyncRun(sql, runId, { persisted: 1 });

      // seed 一个候选人 + 画像（本地评分候选池）
      const candExt = `m-cand-${marker}`;
      const [candRow] = await sql`
        insert into candidates (external_id, display_name, summary)
        values (${candExt}, '王**', '示例工程师')
        returning id
      `;
      await sql`
        insert into candidate_profiles (
          candidate_id, skills, experience_years, location, education, seniority,
          industry, expected_salary_min, expected_salary_max, activity_updated_at
        ) values (
          ${candRow.id}, '[]'::jsonb, 6, '上海', '本科', '高级',
          '互联网', 20, 30, now()
        )
      `;

      // 入队匹配任务（payload 携带 jobIds）
      const taskRepo = createAsyncTaskRepository(sql);
      const matchKey = `match-candidates:manual:${marker}`;
      const matchTaskId = await taskRepo.enqueueTask({
        kind: "match_candidates_sync",
        idempotencyKey: matchKey,
        payload: { jobIds: [jobId] },
        scheduledAt: now,
      });
      taskIds.push(matchTaskId);

      const callTool = dispatchCallTool(
        async () =>
          fakePage({
            total: 0,
            page: 1,
            pageSize: 20,
            totalPages: 0,
            list: [],
          }),
        { operableIds: [] },
      );
      await runScheduledTick({
        env,
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });

      const [task] = await sql`
        select status from async_tasks where id = ${matchTaskId}
      `;
      assert.equal(task.status, "succeeded", "匹配任务应成功");
      const [matchCount] = await sql`
        select count(*)::int as n from matches where job_id = ${jobId}
      `;
      assert.equal(matchCount.n, 1, "匹配结果落库");
      await sql`delete from async_tasks where idempotency_key = ${matchKey}`;
    } finally {
      // cleanupFixture 按 FK 顺序清理 matches/candidates/job_requirements/jobs/source
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);
