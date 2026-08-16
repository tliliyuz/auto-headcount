import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import {
  BrowserCollectionContractError,
  LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  LIEBIDE_PLATFORM_ORIGIN,
} from "../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import {
  enqueueBrowserJobJdBackfillTasks,
  runBrowserJobJdBackfill,
} from "../lib/jobs/browser-job-jd-backfill.mjs";
import {
  createBrowserJobJdBackfillRepository,
  listJobJdBackfills,
} from "../lib/jobs/browser-job-jd-backfill-repository.mjs";
import { processDueTasks } from "../lib/jobs/sync-scheduler.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

function fixtureJob(externalId, ageDays) {
  return {
    externalId,
    title: `Job ${externalId}`,
    companyName: "Fixture Company",
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays,
    lastRecommendationAt: null,
    category: "互联网",
    city: "上海",
    salaryMin: 30,
    salaryMax: 60,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

/** 可操作职位（job_description 恒 null，persistUnderServedJob 不写该列）。 */
async function seedActionableJob(sql, sourceId, externalId) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId: runId,
    rawPayload: { job_id: externalId },
    job: fixtureJob(externalId, 9),
    encryption,
    operabilityStatus: "actionable",
  });
  await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
  return jobId;
}

function createFakeRelay({ missingJdFor = [], throwFor = [] } = {}) {
  const missing = new Set(missingJdFor);
  const throwing = new Set(throwFor);
  return {
    async getConnectionStatus() {
      return {
        status: "READY", ready: true, sessionMatched: true,
        origin: LIEBIDE_PLATFORM_ORIGIN, authState: "authenticated",
      };
    },
    async extractJobDetail(input) {
      const externalId = input.expectedExternalId;
      if (throwing.has(externalId)) {
        throw new BrowserCollectionContractError("record jobDescription must not be empty");
      }
      const base = {
        contractId: LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
        contractVersion: 2,
        sourceOrigin: LIEBIDE_PLATFORM_ORIGIN,
        capturedAt: new Date().toISOString(),
        contentHash: "d".repeat(64),
        externalId,
        title: "示例数据工程师",
        status: "active",
        city: "上海",
        salaryMin: 20000,
        salaryMax: 35000,
        publishedAt: null,
        validRecommendationCount: 0,
      };
      if (missing.has(externalId)) {
        return { ...base, jobDescription: null, jobDescriptionMissing: true };
      }
      return {
        ...base,
        jobDescription: `岗位职责：负责虚构数据平台建设（${externalId}）。`,
        jobDescriptionMissing: false,
      };
    },
  };
}

/** 清理：按 source 删除台账/任务/回执/职位/同步/来源（FK 顺序）；无论删除是否出错都关闭连接。 */
async function cleanup(sql, { sourceId, jobIds }) {
  try {
    if (sourceId) {
      await sql`delete from job_jd_backfills where job_id = any(${jobIds})`;
      await sql`delete from async_tasks where payload->>'sourceConnectionId' = ${sourceId}`;
      await sql`delete from raw_records where source_connection_id = ${sourceId}`;
      await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
      await sql`delete from jobs where source_connection_id = ${sourceId}`;
      await sql`delete from source_connections where id = ${sourceId}`;
    }
  } finally {
    await sql.end();
  }
}

test(
  "JD 回填：入队 → 浏览器详情 filled/no_provider_jd/failed → 台账防重采",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-backfill-${marker}`,
      environment: "test",
      displayName: "Fixture JD Backfill",
    };
    let sourceId;
    const jobIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      jobIds.push(await seedActionableJob(sql, sourceId, ext("bf-j1")));
      jobIds.push(await seedActionableJob(sql, sourceId, ext("bf-j2")));
      jobIds.push(await seedActionableJob(sql, sourceId, ext("bf-j3")));

      const sourceResult = await sql`
        select id, external_id as "externalId", title
        from jobs where source_connection_id = ${sourceId}
        order by external_id
      `;
      assert.equal(sourceResult.length, 3);

      // 入队：只选可操作缺 JD（3 个都缺）。
      const first = await enqueueBrowserJobJdBackfillTasks({
        sql,
        source,
        userId: "ops_fixture",
        deviceId: "device-fixture-001",
      });
      assert.equal(first.scanned, 3);
      assert.equal(first.enqueued, 3);
      assert.equal(first.skipped.length, 0);

      const tasks = await sql`
        select payload from async_tasks
        where kind = 'browser_job_jd_backfill'
          and payload->>'sourceConnectionId' = ${sourceId}
      `;
      assert.equal(tasks.length, 3);
      for (const row of tasks) {
        assert.equal(row.payload.contractId, LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID);
      }

      // 执行：j1 filled、j2 no_provider_jd、j3 契约失败 → failed。
      const relay = createFakeRelay({
        missingJdFor: [ext("bf-j2")],
        throwFor: [ext("bf-j3")],
      });
      const repository = createBrowserJobJdBackfillRepository(sql, { encryption });
      for (const row of tasks) {
        const outcome = await runBrowserJobJdBackfill({ task: row.payload, relayClient: relay, repository });
        assert.equal(outcome.status, row.payload.externalId === ext("bf-j3") ? "failed" : "succeeded");
      }

      const j1 = await sql`select job_description from jobs where id = ${jobIds[0]}`;
      assert.ok(j1[0].job_description.includes("bf-j1"), "j1 回填 JD");
      const j2 = await sql`select job_description from jobs where id = ${jobIds[1]}`;
      assert.equal(j2[0].job_description, null, "j2 供应方无 JD，不更新");
      const j3 = await sql`select job_description from jobs where id = ${jobIds[2]}`;
      assert.equal(j3[0].job_description, null, "j3 契约失败，不更新");

      const ledger = await sql`
        select job_id, outcome, error_code, content_hash, raw_record_id
        from job_jd_backfills where source_connection_id = ${sourceId}
        order by created_at
      `;
      assert.equal(ledger.length, 3);
      const byJob = new Map(ledger.map((row) => [row.job_id, row]));
      assert.equal(byJob.get(jobIds[0]).outcome, "filled");
      assert.notEqual(byJob.get(jobIds[0]).raw_record_id, null, "filled 有回执快照");
      assert.equal(byJob.get(jobIds[1]).outcome, "no_provider_jd");
      assert.notEqual(byJob.get(jobIds[1]).raw_record_id, null, "no_provider_jd 有回执快照");
      assert.equal(byJob.get(jobIds[2]).outcome, "failed");
      assert.equal(byJob.get(jobIds[2]).raw_record_id, null, "failed 无回执快照");
      assert.equal(byJob.get(jobIds[2]).error_code, "BROWSER_COLLECTION_CONTRACT_INVALID");

      const raw = await sql`
        select count(*)::int as n from raw_records
        where source_connection_id = ${sourceId}
          and schema_version = ${LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID}
          and entity_type = 'job'
      `;
      assert.equal(raw[0].n, 2, "filled 与 no_provider_jd 各落一条回执快照（failed 无回执）");

      // 台账读：分页返回 3 条（含职位标题），按 outcome 过滤。
      const all = await listJobJdBackfills(sql, { pageSize: 50 });
      assert.equal(all.total, 3);
      assert.equal(all.list.length, 3);
      const filledRows = all.list.filter((r) => r.outcome === "filled");
      assert.equal(filledRows.length, 1);
      assert.ok(filledRows[0].jobTitle === `Job ${ext("bf-j1")}`, "台账带职位标题");
      assert.ok(filledRows[0].jdLength > 0, "filled 记录 JD 长度");
      const failedRows = await listJobJdBackfills(sql, { outcome: "failed" });
      assert.equal(failedRows.total, 1);
      assert.equal(failedRows.list[0].errorCode, "BROWSER_COLLECTION_CONTRACT_INVALID");
      const missingRows = await listJobJdBackfills(sql, { outcome: "no_provider_jd" });
      assert.equal(missingRows.total, 1);
      assert.equal(missingRows.list[0].jdLength, 0, "no_provider_jd 无 JD 长度");

      // 幂等：全部已尝试（台账）→ 二次入队扫描 0。
      const second = await enqueueBrowserJobJdBackfillTasks({
        sql,
        source,
        userId: "ops_fixture",
        deviceId: "device-fixture-001",
      });
      assert.equal(second.scanned, 0);
      assert.equal(second.enqueued, 0);

      // 已回填 j1 的 job_description 不变式：not null 且不再入队。
      const j1Again = await sql`
        select count(*)::int as n from jobs
        where id = ${jobIds[0]} and job_description is not null
      `;
      assert.equal(j1Again[0].n, 1);
    } finally {
      await cleanup(sql, { sourceId, jobIds });
    }
  },
);

test(
  "JD 回填入队：活跃任务守卫去重 + succeeded 无台账任务不阻塞二次触发（防 23505）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-backfill-redo-${marker}`,
      environment: "test",
      displayName: "Fixture JD Backfill Redo",
    };
    let sourceId;
    const jobIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      jobIds.push(await seedActionableJob(sql, sourceId, ext("redo-j1")));

      const first = await enqueueBrowserJobJdBackfillTasks({
        sql, source, userId: "ops_fixture", deviceId: "device-fixture-001",
      });
      assert.equal(first.enqueued, 1);

      // 活跃（pending）任务守卫：同目标再入队被拦截（skipped）
      const whilePending = await enqueueBrowserJobJdBackfillTasks({
        sql, source, userId: "ops_fixture", deviceId: "device-fixture-001",
      });
      assert.equal(whilePending.enqueued, 0);
      assert.deepEqual(whilePending.skipped, [ext("redo-j1")]);

      // 模拟旧调度器 no-op：任务 succeeded 但无台账 → 二次触发必须能新建任务（幂等键随机后缀，不再 23505）
      await sql`
        update async_tasks set status = 'succeeded', finished_at = now()
        where payload->>'sourceConnectionId' = ${sourceId}
      `;
      const redo = await enqueueBrowserJobJdBackfillTasks({
        sql, source, userId: "ops_fixture", deviceId: "device-fixture-001",
      });
      assert.equal(redo.enqueued, 1, "succeeded 无台账任务不阻塞二次触发（修复 23505）");
    } finally {
      await cleanup(sql, { sourceId, jobIds });
    }
  },
);

test(
  "JD 回填经调度器 processDueTasks 完整分发：认领→分发→回填→sync_run/台账落库",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-backfill-dispatch-${marker}`,
      environment: "test",
      displayName: "Fixture JD Backfill Dispatch",
    };
    let sourceId;
    const jobIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      jobIds.push(await seedActionableJob(sql, sourceId, ext("bfd-j1")));

      const enqueued = await enqueueBrowserJobJdBackfillTasks({
        sql,
        source,
        userId: "ops_fixture",
        deviceId: "device-fixture-001",
      });
      assert.equal(enqueued.enqueued, 1);

      // 经调度器认领 → 分发到 runBrowserJobJdBackfill（browserRelay 注入假 relay）。
      const summary = await processDueTasks(sql, {
        env: {
          APP_ENCRYPTION_KEY: encryption.key,
          APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion,
        },
        now: new Date(Date.now() + 5000),
        browserRelay: createFakeRelay(),
      });
      assert.ok(summary.succeeded >= 1, "回填任务经调度器分发应成功");

      const [task] = await sql`
        select status, last_error_code from async_tasks
        where payload->>'sourceConnectionId' = ${sourceId}
      `;
      assert.equal(task.status, "succeeded", "回填任务终态 succeeded");
      assert.equal(task.last_error_code, null);

      const j1 = await sql`select job_description from jobs where id = ${jobIds[0]}`;
      assert.ok(j1[0].job_description.includes(ext("bfd-j1")), "调度分发后 JD 回填");
      const [run] = await sql`
        select count(*)::int as n from sync_runs
        where source_connection_id = ${sourceId} and sync_type = 'browser_job_jd_backfill'
      `;
      assert.equal(run.n, 1, "调度分发落一条 sync_run");
      const [ledger] = await sql`
        select count(*)::int as n, max(outcome) as outcome from job_jd_backfills where job_id = ${jobIds[0]}
      `;
      assert.equal(ledger.n, 1);
      assert.equal(ledger.outcome, "filled");
    } finally {
      await cleanup(sql, { sourceId, jobIds });
    }
  },
);
