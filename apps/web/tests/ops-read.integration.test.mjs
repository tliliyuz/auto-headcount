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
import { listUnderServedJobs } from "../lib/jobs/job-read-repository.mjs";
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
      const all = await listUnderServedJobs(sql, { pageSize: 100 });
      const allIds = new Set(all.list.map((job) => job.externalId));
      assert.equal(allIds.has("a-1"), true);
      assert.equal(allIds.has("a-2"), true);
      for (const excluded of ["a-3", "a-4", "a-5", "a-6"]) {
        assert.equal(allIds.has(excluded), false, `${excluded} 不应入选`);
      }

      // 2) category 与 q 过滤（夹具范围）
      const engineering = await listUnderServedJobs(sql, { category: "Engineering", pageSize: 100 });
      const engIds = engineering.list.map((job) => job.externalId);
      assert.equal(engIds.includes("a-1"), true);
      assert.equal(engIds.includes("a-3"), false);
      const byQuery = await listUnderServedJobs(sql, { q: "beta", pageSize: 100 });
      assert.equal(byQuery.list.length >= 1, true);
      assert.equal(
        byQuery.list.every((job) => job.externalId === "a-2"),
        true,
      );
      const byCity = await listUnderServedJobs(sql, { q: "beijing", pageSize: 100 });
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
