import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import {
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import {
  getJobById,
  listUnderServedJobs,
} from "../lib/jobs/job-read-repository.mjs";
import {
  listSources,
  listSyncRuns,
} from "../lib/sources/source-read-repository.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

function fixtureJob(externalId, { title, category, city, ageDays }) {
  return {
    externalId,
    title,
    companyName: `Fixture Company ${title}`,
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays,
    lastRecommendationAt: null,
    category,
    city,
    salaryMin: 10,
    salaryMax: 20,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

test(
  "业务只读端点：沉睡职位过滤/分页/投影 + 数据源与同步批次查询",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceIdA;
    let sourceIdB;

    try {
      // Source A：成功同步，含边界与非合格职位
      sourceIdA = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-a`,
        environment: "test",
        displayName: "Fixture Source A",
      });
      const runA = await startSyncRun(sql, sourceIdA, "under_served_jobs");
      const jobFixtures = [
        fixtureJob("a-1", { title: "Alpha Engineer", category: "Engineering", city: "Shanghai", ageDays: 7 }),
        fixtureJob("a-2", { title: "Beta Analyst", category: "Data", city: "Beijing", ageDays: 30 }),
        fixtureJob("a-3", { title: "Gamma Engineer", category: "Engineering", city: "Shenzhen", ageDays: 12 }),
        fixtureJob("a-4", { title: "Delta Analyst", category: "Data", city: "Hangzhou", ageDays: 15 }),
        fixtureJob("a-5", { title: "Epsilon Ops", category: "Engineering", city: "Guangzhou", ageDays: 6 }),
        fixtureJob("a-6", { title: "Zeta Architect", category: "Data", city: "Chengdu", ageDays: 31 }),
      ];
      for (const job of jobFixtures) {
        await persistUnderServedJob(sql, {
          sourceId: sourceIdA,
          syncRunId: runA,
          rawPayload: { job_id: job.externalId },
          job,
          encryption,
        });
      }
      await finishSyncRun(sql, runA, { processed: 6, persisted: 6 });

      // 用真实列使两条合格记录出局：非零有效推荐 + 失效状态
      await sql`
        update jobs set valid_recommendation_count = 3
        where source_connection_id = ${sourceIdA} and external_id = 'a-3'
      `;
      await sql`
        update jobs set status = 'inactive'
        where source_connection_id = ${sourceIdA} and external_id = 'a-4'
      `;

      // Source B：失败同步
      sourceIdB = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-b`,
        environment: "test",
        displayName: "Fixture Source B",
      });
      const runB = await startSyncRun(sql, sourceIdB, "under_served_jobs");
      await failSyncRun(sql, runB, "RATE_LIMITED", { processed: 0 });

      // 1) 沉睡规则边界（夹具范围断言，容忍共享 DB 并行数据）：
      //    7/30 天含边界入选，6/31 天、失效、非零推荐出局
      // 夹具可能被真实数据（按沉睡天数排序）挤出前 N 页：查询页大小放宽到足以包含夹具
      const all = await listUnderServedJobs(sql, { pageSize: 5000 });
      const allIds = new Set(all.list.map((job) => job.externalId));
      assert.equal(allIds.has("a-1"), true);
      assert.equal(allIds.has("a-2"), true);
      for (const excluded of ["a-3", "a-4", "a-5", "a-6"]) {
        assert.equal(allIds.has(excluded), false, `${excluded} 不应入选`);
      }

      // 2) category 与 q 过滤（夹具范围）
      const engineering = await listUnderServedJobs(sql, { category: "Engineering", pageSize: 5000 });
      const engIds = engineering.list.map((job) => job.externalId);
      assert.equal(engIds.includes("a-1"), true);
      assert.equal(engIds.includes("a-3"), false);
      const byQuery = await listUnderServedJobs(sql, { q: "beta", pageSize: 5000 });
      assert.equal(byQuery.list.length >= 1, true);
      assert.equal(
        byQuery.list.every((job) => job.externalId === "a-2"),
        true,
      );
      const byCity = await listUnderServedJobs(sql, { q: "beijing", pageSize: 5000 });
      assert.equal(byCity.list.length >= 1, true);
      assert.equal(
        byCity.list.every((job) => job.externalId === "a-2"),
        true,
      );

      // 3) 分页一致性（并发容忍：total 恒定、页间不重叠、totalPages 公式正确）
      const pageOne = await listUnderServedJobs(sql, { page: 1, pageSize: 2 });
      const pageTwo = await listUnderServedJobs(sql, { page: 2, pageSize: 2 });
      assert.equal(pageOne.total, pageTwo.total);
      assert.equal(pageOne.totalPages, Math.ceil(pageOne.total / 2));
      const pageOneIds = new Set(pageOne.list.map((job) => job.externalId));
      assert.equal(
        pageTwo.list.some((job) => pageOneIds.has(job.externalId)),
        false,
      );
      assert.equal(pageOne.list.length + pageTwo.list.length <= pageOne.total, true);

      // 4) 字段投影：camelCase、含内部字段、绝不出现 payload_* 或 cursor
      const a1 = all.list.find((job) => job.externalId === "a-1");
      assert.equal(a1.ageDays, 7);
      assert.equal(a1.recommendationCount, 0);
      assert.equal(a1.status, "active");
      assert.equal(typeof a1.companyName, "string");
      assert.equal(typeof a1.detailedLocation === "string" || a1.detailedLocation === null, true);
      assert.equal("payload_ciphertext" in a1, false);
      assert.equal(Object.keys(a1).some((key) => key.startsWith("payload_")), false);

      // 5) listSources：连接 + 最新同步摘要（夹具范围）
      const sources = await listSources(sql, { pageSize: 100 });
      assert.equal(sources.total >= 2, true);
      const sourceMap = new Map(sources.list.map((s) => [s.provider, s]));
      const sourceA = sourceMap.get(`fixture-${marker}-a`);
      const sourceB = sourceMap.get(`fixture-${marker}-b`);
      assert.equal(sourceA.displayName, "Fixture Source A");
      assert.equal(sourceA.lastRunStatus, "succeeded");
      assert.equal(sourceA.lastRunStats.persisted, 6);
      assert.equal(sourceB.lastRunStatus, "failed");
      assert.equal(sourceB.lastRunErrorCode, "RATE_LIMITED");

      // 6) listSyncRuns：join 字段与 status 过滤（夹具范围）
      const syncRuns = await listSyncRuns(sql, { pageSize: 100 });
      assert.equal(syncRuns.total >= 2, true);
      const runBView = syncRuns.list.find(
        (run) => run.sourceDisplayName === "Fixture Source B",
      );
      assert.equal(runBView.status, "failed");
      assert.equal(runBView.errorCode, "RATE_LIMITED");
      const succeeded = await listSyncRuns(sql, { status: "succeeded", pageSize: 100 });
      assert.equal(succeeded.list.every((run) => run.status === "succeeded"), true);
      assert.equal(
        succeeded.list.some((run) => run.sourceDisplayName === "Fixture Source A"),
        true,
      );
      assert.equal("cursor" in runBView, false);
    } finally {
      for (const sourceId of [sourceIdA, sourceIdB]) {
        if (sourceId) {
          await sql`delete from jobs where source_connection_id = ${sourceId}`;
          await sql`delete from raw_records where source_connection_id = ${sourceId}`;
          await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
          await sql`delete from source_connections where id = ${sourceId}`;
        }
      }
      await sql.end();
    }
  },
);

test(
  "valid_recommendation_count：真值 0 纳入沉睡，重同步不覆盖既有计数",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-n6`,
        environment: "test",
        displayName: "Fixture N6 Source",
      });

      // 首次同步写入两条零推荐职位（NULL）
      const run1 = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: run1,
        rawPayload: { job_id: "n6-zero" },
        job: fixtureJob("n6-zero", { title: "N6 Zero", category: "Data", city: "Hangzhou", ageDays: 9 }),
        encryption,
      });
      await finishSyncRun(sql, run1, { processed: 1, persisted: 1 });

      // 推荐工作流写入真值 0（而非 NULL）
      await sql`
        update jobs set valid_recommendation_count = 0
        where source_connection_id = ${sourceId} and external_id = 'n6-zero'
      `;

      // 真值 0 仍应纳入沉睡列表（q 按标题 "N6 Zero" 命中）
      const afterZero = await listUnderServedJobs(sql, { q: "N6", pageSize: 100 });
      assert.equal(afterZero.list.length, 1, "valid_recommendation_count=0 应纳入沉睡");
      assert.equal(afterZero.list[0].recommendationCount, 0);

      // 重同步：upsert 不得用 NULL 覆盖既有计数
      const run2 = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: run2,
        rawPayload: { job_id: "n6-zero" },
        job: fixtureJob("n6-zero", { title: "N6 Zero", category: "Data", city: "Hangzhou", ageDays: 9 }),
        encryption,
      });
      await finishSyncRun(sql, run2, { processed: 1, persisted: 1 });

      const [row] = await sql`
        select valid_recommendation_count from jobs
        where source_connection_id = ${sourceId} and external_id = 'n6-zero'
      `;
      assert.equal(row.valid_recommendation_count, 0, "重同步不得用 NULL 覆盖推荐计数");
      const afterResync = await listUnderServedJobs(sql, { q: "N6", pageSize: 100 });
      assert.equal(afterResync.list.length, 1, "重同步后真值 0 仍应纳入沉睡");
    } finally {
      if (sourceId) {
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "getJobById：返回含 jobDescription 的内部详情投影，未知 id 返回 undefined",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-detail`,
        environment: "test",
        displayName: "Fixture Detail Source",
      });
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: runId,
        rawPayload: { job_id: "d-1" },
        job: fixtureJob("d-1", { title: "Detail Engineer", category: "Engineering", city: "Shanghai", ageDays: 11 }),
        encryption,
      });
      await sql`
        update jobs set job_description = '完整 JD 文本' , detailed_location = '上海·张江'
        where source_connection_id = ${sourceId} and external_id = 'd-1'
      `;
      await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });

      const [saved] = await sql`
        select id from jobs
        where source_connection_id = ${sourceId} and external_id = 'd-1'
      `;

      const detail = await getJobById(sql, saved.id);
      assert.equal(detail.externalId, "d-1");
      assert.equal(detail.title, "Detail Engineer");
      assert.equal(detail.jobDescription, "完整 JD 文本");
      assert.equal(detail.detailedLocation, "上海·张江");
      assert.equal(typeof detail.companyName, "string");
      assert.equal("portalUrl" in detail, false, "详情投影不得含 portal_url");
      assert.equal(Object.keys(detail).some((k) => k.startsWith("payload_")), false);

      const unknown = await getJobById(sql, randomUUID());
      assert.equal(unknown, undefined, "未知 id 返回 undefined → 路由映射 404");
    } finally {
      if (sourceId) {
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);
