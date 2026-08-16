import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { BrowserRelayError } from "../lib/adapters/csdn-browser/relay-client.mjs";
import { createAsyncTaskRepository } from "../lib/jobs/async-task-repository.mjs";
import { createBrowserJobBatchRepository } from "../lib/jobs/browser-job-batch-repository.mjs";
import { createBrowserCandidateBatchRepository } from "../lib/jobs/browser-candidate-repository.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import {
  buildSyncIdempotencyKey,
  enqueueDueSyncTasks,
  enqueueProjectionFilterTasks,
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
    MATCH_AUTOMATION_ENABLED: "false",
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
 *
 * `match_pipeline_v2` 由真实 docker scheduler 周期入队并执行（dev 默认 MATCH_AUTOMATION_ENABLED
 * 未关闭）：既可能是 running（正在执行），也可能刚入队仍是 pending——若测试 tick 的 claimDueTasks
 * 认领到它，会因测试环境无 scoringAdapter 失败并污染 failed 计数。因此 pending 和 running 都回收。
 */
async function reclaimRunningSyncTasks(sql) {
  await sql`
    update async_tasks
    set status = 'failed', last_error_code = 'TEST_SLATE_RESET',
        finished_at = now(), updated_at = now()
    where kind in ('under_served_sync', 'job_details_sync', 'match_candidates_sync', 'browser_job_collect', 'browser_job_batch_discover', 'browser_candidate_collect', 'browser_candidate_discovery', 'match_pipeline_v2')
      and status in ('pending', 'running')
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
      taskIds.push(result.taskId, result.detailsTaskId, result.requirementsTaskId);
      assert.equal(result.enqueued, true);
      assert.equal(result.detailsEnqueued, true);
      assert.equal(result.requirementsEnqueued, true);
      // under_served + job_details + job_requirements_extract 三个任务均成功
      assert.equal(result.succeeded, 3);
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
        insert into candidates (source_connection_id, external_id, display_name, summary)
        values (${sourceId}, ${candExt}, '王**', '示例工程师')
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

test(
  "调度分发：match_pipeline_v2 任务被认领执行，scoringAdapter 注入并空跑成功",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    await reclaimRunningSyncTasks(sql);

    const taskRepo = createAsyncTaskRepository(sql);
    const idempotencyKey = `match-pipeline-v2:${marker}`;
    const taskId = await taskRepo.enqueueTask({
      kind: "match_pipeline_v2",
      idempotencyKey,
      payload: { source: "automatic" },
      scheduledAt: now,
    });

    // spy 适配器：记录是否被调度器注入并调用；空候选池时管线应空跑成功。
    let adapterCalls = 0;
    const spyAdapter = {
      metadata: {
        adapterId: "spy-test",
        adapterVersion: "1",
        modelId: "spy-model",
        modelRevision: "fixture",
        promptVersion: "prompt/v1",
        schemaVersion: "llm-detail-score/v1",
      },
      async score() {
        adapterCalls += 1;
        throw new Error("should not be called with empty pool");
      },
    };

    try {
      const counts = await processDueTasks(sql, {
        env,
        now,
        mcp: undefined,
        scoringAdapter: spyAdapter,
      });
      assert.equal(counts.claimed, 1);
      assert.equal(counts.succeeded, 1, "match_pipeline_v2 空跑应 succeeded");
      assert.equal(counts.failed, 0);

      const [task] = await sql`
        select status from async_tasks where id = ${taskId}
      `;
      assert.equal(task.status, "succeeded");
      assert.equal(adapterCalls, 0, "空候选池不调用 adapter.score（无 LLM 成本）");

      // 审计应记录 match 管线 stats（含 pending/selected/scored 白名单键）
      const [audit] = await sql`
        select metadata from audit_logs
        where action = 'sync.run' and request_id = ${taskId}
      `;
      assert.ok(audit, "调度应写 sync.run 审计");
      assert.ok("pending" in audit.metadata, "审计应含 pending 统计键");
      assert.ok("selected" in audit.metadata, "审计应含 selected 统计键");
    } finally {
      await sql`delete from async_tasks where id = ${taskId}`;
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        await t`delete from audit_logs where action = 'sync.run' and request_id = ${taskId}`;
      });
      await sql.end();
    }
  },
);

test(
  "调度分发：match_projection_filter 任务被认领执行，职位投影落库（候选人无脱敏详情被跳过）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const env = fixtureEnv(source);
    const now = new Date();
    const taskIds = [];
    const jobIds = [];
    let candRow;
    await reclaimRunningSyncTasks(sql);

    try {
      // seed 两个可操作沉睡职位
      const sourceId = await getOrCreateSourceConnection(sql, source);
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      for (const [i, ext] of ["pf-1", "pf-2"].entries()) {
        const { jobId } = await persistUnderServedJob(sql, {
          sourceId,
          syncRunId: runId,
          rawPayload: { job_id: ext },
          job: {
            externalId: ext,
            title: `Proj Job ${i + 1}`,
            companyName: "Fixture Co",
            ownerExternalId: "fixture-owner",
            ownerName: "Fixture Owner",
            ageDays: 7 + i * 5,
            lastRecommendationAt: null,
            category: "Engineering",
            city: "Shanghai",
            salaryMin: 20,
            salaryMax: 30,
            portalUrl: `https://portal.invalid/jobs/${ext}`,
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
        jobIds.push(jobId);
      }
      await finishSyncRun(sql, runId, { persisted: 2 });

      // seed 一个候选人 + 画像（无脱敏详情来源 → 调度侧应计 piiRejected 并跳过）
      const candExt = `pf-cand-${marker}`;
      [candRow] = await sql`
        insert into candidates (source_connection_id, external_id, display_name, summary)
        values (${sourceId}, ${candExt}, '王**', '示例工程师')
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

      const enqueued = await enqueueProjectionFilterTasks(sql, {
        now,
        intervalMs: SIX_HOURS_MS,
      });
      assert.equal(enqueued.projectionEnqueued, true);
      taskIds.push(enqueued.taskId);

      const counts = await processDueTasks(sql, { env, now });
      assert.equal(counts.succeeded, 1, "投影任务应 succeeded");

      const [task] = await sql`
        select status from async_tasks where id = ${enqueued.taskId}
      `;
      assert.equal(task.status, "succeeded");

      // 两个职位都应有 consumable 投影（rules/v1）
      const projections = await sql`
        select job_id, status, generator_version from job_match_projections
        where job_id = any(${jobIds})
      `;
      assert.equal(projections.length, 2, "两个职位都应有投影");
      for (const p of projections) {
        assert.equal(p.status, "consumable");
        assert.equal(p.generator_version, "rules/v2");
      }

      // 候选人无脱敏详情 → 不落消费态候选投影 → 0 filter 结果
      const [candProj] = await sql`
        select count(*)::int as n from candidate_match_projections
        where candidate_id = ${candRow.id}
      `;
      assert.equal(candProj.n, 0, "无脱敏详情来源 → 不落候选投影");
      const [filterCount] = await sql`
        select count(*)::int as n from match_filter_results
      `;
      assert.equal(filterCount.n, 0, "无消费态候选投影 → 0 filter 结果");

      // 审计应含 jobsProjected / candidatesQueried / piiRejected 白名单键
      const [audit] = await sql`
        select metadata from audit_logs
        where action = 'sync.run' and request_id = ${enqueued.taskId}
      `;
      assert.ok(audit, "调度应写 sync.run 审计");
      assert.equal(audit.metadata.jobsProjected, 2);
      assert.equal(audit.metadata.candidatesQueried, 1);
      assert.equal(audit.metadata.piiRejected, 1);
    } finally {
      // FK 顺序清理：filter_results → 投影 → 候选人 → 源 → 任务/审计
      if (jobIds.length) {
        await sql`
          delete from match_filter_results
          where job_projection_id in (
            select id from job_match_projections where job_id = any(${jobIds})
          )
        `;
        await sql`delete from job_match_projections where job_id = any(${jobIds})`;
      }
      if (candRow) {
        await sql`delete from candidate_match_projections where candidate_id = ${candRow.id}`;
        await sql`delete from candidate_profiles where candidate_id = ${candRow.id}`;
        await sql`delete from candidates where id = ${candRow.id}`;
      }
      const [autoMatch] = await sql`
        select id from source_connections where provider = 'auto-match'
      `;
      if (autoMatch) {
        await sql`delete from sync_runs where source_connection_id = ${autoMatch.id}`;
        await sql`delete from source_connections where id = ${autoMatch.id}`;
      }
      // 投影任务（payload 为 { source: "automatic" }，cleanupFixture 按 fixture 源 provider
      // 匹配不到，必须显式删除，避免同周期幂等键残留污染后续测试）
      await sql`delete from async_tasks where id = any(${taskIds})`;
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "enqueueProjectionFilterTasks 幂等：同周期重复入队返回同一任务",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const now = new Date();
    const taskIds = [];
    try {
      const first = await enqueueProjectionFilterTasks(sql, {
        now,
        intervalMs: SIX_HOURS_MS,
      });
      const second = await enqueueProjectionFilterTasks(sql, {
        now,
        intervalMs: SIX_HOURS_MS,
      });
      assert.equal(first.projectionEnqueued, true);
      assert.equal(second.projectionEnqueued, false);
      assert.equal(second.taskId, first.taskId);
      const [count] = await sql`
        select count(*)::int as n from async_tasks
        where idempotency_key = ${first.idempotencyKey}
      `;
      assert.equal(count.n, 1, "同周期只应有一条投影任务");
      if (first.taskId) taskIds.push(first.taskId);
    } finally {
      await sql`delete from async_tasks where id = any(${taskIds})`;
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        await t`delete from audit_logs where request_id = any(${taskIds})`;
      });
      await sql.end();
    }
  },
);

test(
  "MATCH_AUTOMATION_ENABLED 门禁：false 不入队投影任务，true 入队",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(marker);
    const now = new Date();
    const taskIds = [];
    const callTool = dispatchCallTool(
      async () =>
        fakePage({ total: 0, page: 1, pageSize: 20, totalPages: 0, list: [] }),
      { operableIds: [] },
    );
    await reclaimRunningSyncTasks(sql);

    try {
      // 关闭自动匹配 → 投影任务不入队
      const off = await runScheduledTick({
        env: fixtureEnv(source),
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      assert.equal(off.projectionsEnqueued, false);

      // 开启自动匹配 → 投影任务入队（当期认领执行，0 职位空跑 succeeded）
      const on = await runScheduledTick({
        env: { ...fixtureEnv(source), MATCH_AUTOMATION_ENABLED: "true" },
        sql,
        now,
        intervalMs: SIX_HOURS_MS,
        mcp: { callTool },
      });
      assert.equal(on.projectionsEnqueued, true);
      assert.ok(on.projectionsTaskId, "应有投影任务 id");
      if (on.projectionsTaskId) taskIds.push(on.projectionsTaskId);
      if (on.matchesTaskId) taskIds.push(on.matchesTaskId);
    } finally {
      await sql`delete from async_tasks where id = any(${taskIds})`;
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        await t`delete from audit_logs where request_id = any(${taskIds})`;
      });
      const [autoMatch] = await sql`
        select id from source_connections where provider = 'auto-match'
      `;
      if (autoMatch) {
        await sql`delete from sync_runs where source_connection_id = ${autoMatch.id}`;
        await sql`delete from source_connections where id = ${autoMatch.id}`;
      }
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "browser_job_collect 突发认领：同一批次到期详情任务一次认领多条，串行 kind 仍只认领一条",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const now = new Date();
    const batchKind = "browser_job_collect";
    const serialKind = `fixture-burst-serial:${marker}`;
    try {
      const taskRepo = createAsyncTaskRepository(sql);
      const rows = [
        { kind: batchKind, key: "c1" },
        { kind: batchKind, key: "c2" },
        { kind: batchKind, key: "c3" },
        { kind: serialKind, key: "s1" },
        { kind: serialKind, key: "s2" },
      ];
      for (const { kind, key } of rows) {
        await taskRepo.enqueueTask({
          kind,
          idempotencyKey: `burst:${marker}:${key}`,
          payload: {},
          scheduledAt: new Date(0),
        });
      }
      const claimed = await taskRepo.claimDueTasks({ limit: 10, now });
      const claimedByKind = (kind) => claimed.filter((t) => t.kind === kind);
      assert.equal(
        claimedByKind(batchKind).length,
        3,
        "browser_job_collect 突发认领全部到期详情任务",
      );
      assert.equal(
        claimedByKind(serialKind).length,
        1,
        "串行 kind 仍只认领最早一条",
      );
    } finally {
      await sql`delete from async_tasks where idempotency_key like ${`burst:${marker}%`}`;
      await sql.end();
    }
  },
);

test(
  "browser_candidate_collect 突发认领：同一批次到期详情任务一次认领多条，串行 kind 仍只认领一条",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const now = new Date();
    const batchKind = "browser_candidate_collect";
    const serialKind = `fixture-burst-serial:${marker}`;
    try {
      const taskRepo = createAsyncTaskRepository(sql);
      const rows = [
        { kind: batchKind, key: "c1" },
        { kind: batchKind, key: "c2" },
        { kind: batchKind, key: "c3" },
        { kind: serialKind, key: "s1" },
        { kind: serialKind, key: "s2" },
      ];
      for (const { kind, key } of rows) {
        await taskRepo.enqueueTask({
          kind,
          idempotencyKey: `cand-burst:${marker}:${key}`,
          payload: {},
          scheduledAt: new Date(0),
        });
      }
      const claimed = await taskRepo.claimDueTasks({ limit: 10, now });
      const claimedByKind = (kind) => claimed.filter((t) => t.kind === kind);
      assert.equal(
        claimedByKind(batchKind).length,
        3,
        "browser_candidate_collect 突发认领全部到期详情任务",
      );
      assert.equal(
        claimedByKind(serialKind).length,
        1,
        "串行 kind 仍只认领最早一条",
      );
    } finally {
      await sql`delete from async_tasks where idempotency_key like ${`cand-burst:${marker}%`}`;
      await sql.end();
    }
  },
);

test(
  "browser 批次列表：按创建时间倒序返回批次、状态与计数",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const batchRepo = createBrowserJobBatchRepository(sql);
    const [src] = await sql`
      insert into source_connections (provider, environment, status, display_name)
      values (${`fixture-batch-list-${marker}`}, 'test', 'active', 'Fixture Batch List Source')
      returning id
    `;
    try {
      const { batchId } = await batchRepo.createAndEnqueue({
        payload: {
          sourceConnectionId: src.id,
          userId: "fixture-user",
          deviceId: "fixture-device",
          contractId: "liebide-filtered-job-list-v2",
          batchSize: 20,
          maxPages: 20,
        },
        scheduledAt: new Date(),
      });
      const result = await batchRepo.listBatches({ page: 1, pageSize: 10 });
      const mine = result.list.find((row) => row.id === batchId);
      assert.ok(mine, "listBatches 应返回刚创建的批次");
      assert.equal(mine.status, "pending");
      assert.equal(mine.discoveredCount, 0);
      assert.equal(mine.batchSize, 20);
      assert.equal(mine.maxPages, 20);
      assert.equal(mine.sourceConnectionId, src.id);
      assert.ok(mine.createdAt !== null);
      assert.ok(result.total >= 1);
      assert.equal(result.totalPages >= 1, true);
    } finally {
      await sql`delete from browser_collection_batches where source_connection_id = ${src.id}`;
      await sql`delete from source_connections where id = ${src.id}`;
      await sql.end();
    }
  },
);

test(
  "browser_candidate 调度闭环：批次发现 → 详情采集 → 候选人/画像入库 → 批次聚合",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(`cand-${marker}`);
    // 详情任务在发现事务内以 DB now() 排程；后续 processDueTasks 用真实的递进时间保证到期
    const capturedAt = "2026-08-14T09:00:00.000Z";
    const taskIds = [];
    let sourceId;
    const relay = {
      async getConnectionStatus() {
        return { status: "READY", ready: true };
      },
      async discoverTalentPool() {
        return {
          items: [
            { candidateId: `cand-a-${marker}`, title: "数据工程师", realName: "示例甲", pageNumber: 1, position: 1 },
            { candidateId: `cand-b-${marker}`, title: "算法工程师", realName: "示例乙", pageNumber: 1, position: 2 },
          ],
          nextPage: null, nextOffset: null, stopReason: "end_of_results", pagesVisited: 1,
        };
      },
      async extractCandidateDetail({ expectedCandidateId }) {
        const isA = expectedCandidateId === `cand-a-${marker}`;
        return {
          contractId: "liebide-candidate-detail-v1", contractVersion: 1,
          sourceOrigin: "https://portal.liebide.com", capturedAt,
          contentHash: "c".repeat(64),
          candidateId: expectedCandidateId,
          realName: isA ? "示例甲" : "示例乙",
          title: isA ? "数据工程师" : "算法工程师",
          company: "虚构科技", yearOfExperience: isA ? 8 : 6,
          cityName: "北京", school: "虚构大学", major: "计算机", degree: "本科",
          completion: 80, recommendationCount: 3,
          workExperiences: [{ company: "虚构科技", title: "数据工程师" }],
        };
      },
    };
    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const batchRepo = createBrowserCandidateBatchRepository(sql);
      const { batchId, taskId } = await batchRepo.createAndEnqueue({
        payload: {
          sourceConnectionId: sourceId,
          userId: "fixture-user",
          deviceId: "fixture-device",
          contractId: "liebide-talent-pool-list-v1",
          batchSize: 20,
          maxPages: 20,
        },
        scheduledAt: new Date(),
      });
      assert.ok(batchId && taskId);
      taskIds.push(taskId);

      // 发现阶段：认领发现任务 → 差分发现 → 建详情任务
      const env = { APP_ENCRYPTION_KEY: ENC_KEY, APP_ENCRYPTION_KEY_VERSION: "test-v1" };
      // 详情任务在发现事务内以 DB now() 排程；逐次递进 tick 时间保证其到期
      let tickNow = new Date();
      const discoverySummary = await processDueTasks(sql, { env, now: tickNow, browserRelay: relay });
      assert.equal(discoverySummary.succeeded, 1, "发现任务应 succeeded");

      // 详情采集：两个详情任务逐次认领执行（同 kind 串行）
      tickNow = new Date(tickNow.getTime() + 60_000);
      const c1 = await processDueTasks(sql, { env, now: tickNow, browserRelay: relay });
      tickNow = new Date(tickNow.getTime() + 60_000);
      const c2 = await processDueTasks(sql, { env, now: tickNow, browserRelay: relay });
      assert.equal(c1.succeeded + c2.succeeded, 2, "两个详情任务应 succeeded");

      const [candCount] = await sql`
        select count(*)::int as n from candidates where source_connection_id = ${sourceId}
      `;
      assert.equal(candCount.n, 2, "两个候选人画像应落库");
      const profiles = await sql`
        select c.external_id, p.current_title, p.current_company, p.experience_years,
               p.school, p.major
        from candidates c left join candidate_profiles p on p.candidate_id = c.id
        where c.source_connection_id = ${sourceId} order by c.external_id
      `;
      assert.equal(profiles.length, 2);
      assert.equal(profiles[0].current_title, "数据工程师");
      assert.equal(profiles[0].current_company, "虚构科技");
      assert.equal(profiles[0].school, "虚构大学");
      assert.equal(profiles[0].major, "计算机");
      assert.equal(profiles[1].current_title, "算法工程师");

      const [rawCount] = await sql`
        select count(*)::int as n from raw_records
        where source_connection_id = ${sourceId} and entity_type = 'candidate'
      `;
      assert.equal(rawCount.n, 2, "候选人详情应加密存 raw_records");

      const [batch] = await sql`
        select status, discovered_count, succeeded_count, failed_count
        from browser_candidate_batches where id = ${batchId}
      `;
      assert.equal(batch.discovered_count, 2);
      assert.equal(batch.succeeded_count, 2);
      assert.equal(batch.failed_count, 0);
      assert.equal(batch.status, "succeeded");
    } finally {
      const rows = await sql`select id from source_connections where provider = ${source.provider}`;
      for (const row of rows) {
        // 发现阶段持久化的 collect 任务也要清掉，否则残留 pending 任务会污染后续 tick 测试
        await sql`delete from async_tasks where kind in ('browser_candidate_discovery', 'browser_candidate_collect') and payload->>'sourceConnectionId' = ${row.id}`;
        await sql`delete from browser_candidate_batches where source_connection_id = ${row.id}`;
        await sql`delete from candidate_profiles where candidate_id in (select id from candidates where source_connection_id = ${row.id})`;
        await sql`delete from candidates where source_connection_id = ${row.id}`;
      }
      await sql`delete from async_tasks where id = any(${taskIds.filter(Boolean)})`;
      await cleanupFixture(sql, { source, taskIds });
      await sql.end();
    }
  },
);

test(
  "浏览器发现任务对瞬时 relay 故障可重试超过默认 3 次（BROWSER_MAX_ATTEMPTS=6）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = fixtureSource(`cand-retry-${marker}`);
    const failingRelay = {
      async getConnectionStatus() {
        throw new BrowserRelayError("relay unreachable");
      },
      async discoverTalentPool() {
        throw new BrowserRelayError("relay unreachable");
      },
    };
    const env = { APP_ENCRYPTION_KEY: ENC_KEY, APP_ENCRYPTION_KEY_VERSION: "test-v1" };
    let sourceId;
    let taskId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const { taskId: createdTaskId } = await createBrowserCandidateBatchRepository(sql).createAndEnqueue({
        payload: {
          sourceConnectionId: sourceId,
          userId: "fixture-user",
          deviceId: "fixture-device",
          contractId: "liebide-talent-pool-list-v1",
          batchSize: 20,
          maxPages: 20,
        },
        scheduledAt: new Date(),
      });
      taskId = createdTaskId;

      // 指数退避：attempt N 失败后 next_attempt_at = now + 60s*2^(N-1)。逐次推进 tick 时间模拟重试窗口。
      let now = new Date();
      const retryDelays = [60_000, 120_000, 240_000, 480_000, 960_000];
      for (let attempt = 1; attempt <= retryDelays.length + 1; attempt += 1) {
        const summary = await processDueTasks(sql, { env, now, browserRelay: failingRelay });
        const [row] = await sql`select status, attempts from async_tasks where id = ${taskId}`;
        if (attempt < 6) {
          assert.equal(summary.retried, 1, `第 ${attempt} 次失败应 retry`);
          assert.equal(row.status, "pending", `第 ${attempt} 次失败后任务应 pending（默认 3 次此处已 dead）`);
        } else {
          assert.equal(summary.dead, 1, "第 6 次失败才应 dead");
          assert.equal(row.status, "dead");
          assert.equal(row.attempts, 6);
        }
        if (attempt <= retryDelays.length) {
          now = new Date(now.getTime() + retryDelays[attempt - 1] + 1_000);
        }
      }
    } finally {
      const rows = await sql`select id from source_connections where provider = ${source.provider}`;
      for (const row of rows) {
        await sql`delete from async_tasks where kind in ('browser_candidate_discovery', 'browser_candidate_collect') and payload->>'sourceConnectionId' = ${row.id}`;
        await sql`delete from browser_candidate_batches where source_connection_id = ${row.id}`;
      }
      await cleanupFixture(sql, { source, taskIds: [taskId].filter(Boolean) });
      await sql.end();
    }
  },
);

test(
  "候选人批次列表：按创建时间倒序返回批次、状态与计数",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const batchRepo = createBrowserCandidateBatchRepository(sql);
    const [src] = await sql`
      insert into source_connections (provider, environment, status, display_name)
      values (${`fixture-candidate-batch-list-${marker}`}, 'test', 'active', 'Fixture Candidate Batch List Source')
      returning id
    `;
    try {
      const { batchId } = await batchRepo.createAndEnqueue({
        payload: {
          sourceConnectionId: src.id,
          userId: "fixture-user",
          deviceId: "fixture-device",
          contractId: "liebide-talent-pool-list-v1",
          batchSize: 20,
          maxPages: 20,
        },
        scheduledAt: new Date(),
      });
      const result = await batchRepo.listBatches({ page: 1, pageSize: 10 });
      const mine = result.list.find((row) => row.id === batchId);
      assert.ok(mine, "listBatches 应返回刚创建的候选批次");
      assert.equal(mine.status, "pending");
      assert.equal(mine.discoveredCount, 0);
      assert.equal(mine.batchSize, 20);
      assert.equal(mine.maxPages, 20);
      assert.equal(mine.sourceConnectionId, src.id);
      assert.ok(mine.createdAt !== null);
      assert.ok(result.total >= 1);
      assert.equal(result.totalPages >= 1, true);
    } finally {
      await sql`delete from async_tasks where kind = 'browser_candidate_discovery' and payload->>'sourceConnectionId' = ${src.id}`;
      await sql`delete from browser_candidate_batches where source_connection_id = ${src.id}`;
      await sql`delete from source_connections where id = ${src.id}`;
      await sql.end();
    }
  },
);
