import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { runJobDetailsSync } from "../lib/jobs/job-details-sync.mjs";
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
    category: "Engineering",
    city: "Shanghai",
    salaryMin: 20,
    salaryMax: 30,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

/** wb.jobs.get 单职位响应（fix4：JD 补全路径，受控验证 get 返回 Code=0 + job_description）。 */
function jobsGetPage(jobId, jobDescription) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          Code: 0,
          Message: "success",
          Data: {
            job_id: jobId,
            job_title: `Job ${jobId}`,
            status: "active",
            job_description: jobDescription,
          },
        }),
      },
    ],
  };
}

/** seed：可操作（operability_status=actionable）的沉睡职位，JD 空缺。 */
async function seedJobs(sql, sourceId, specs) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  for (const spec of specs) {
    await persistUnderServedJob(sql, {
      sourceId,
      syncRunId: runId,
      rawPayload: { job_id: spec.externalId },
      job: fixtureJob(spec.externalId, spec.ageDays),
      encryption,
      operabilityStatus: "actionable",
    });
  }
  await finishSyncRun(sql, runId, { processed: specs.length, persisted: specs.length });
}

async function cleanup(sql, sourceId) {
  if (sourceId) {
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  await sql.end();
}

test(
  "job_details 同步（DB 驱动 jobs.get）：只对可操作∩沉睡缺 JD 职位补全，命中/缺失计数正确",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-details-${marker}`,
      environment: "test",
      displayName: "Fixture Job Details Sync",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      // 三条可操作沉睡职位缺 JD；j3 上游无 JD（get 返回 null）
      await seedJobs(sql, sourceId, [
        { externalId: "j1", ageDays: 9 },
        { externalId: "j2", ageDays: 12 },
        { externalId: "j3", ageDays: 15 },
      ]);

      let calls = 0;
      const callTool = async (toolName, args) => {
        calls += 1;
        assert.equal(toolName, "wb.jobs.get");
        const jd = { j1: "JD for j1", j2: "JD for j2", j3: null }[args.job_id];
        return jobsGetPage(args.job_id, jd);
      };

      const outcome = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      sourceId = outcome.sourceId;
      assert.equal(outcome.status, "succeeded");
      assert.deepEqual(outcome.stats, {
        queried: 3,
        detailsMatched: 2,
        detailsMissing: 1,
        failed: 0,
      });
      assert.equal(calls, 3, "只对缺 JD 的可操作职位调 jobs.get");

      const rows = await sql`
        select external_id, job_description
        from jobs
        where source_connection_id = ${sourceId}
        order by external_id
      `;
      const map = new Map(rows.map((r) => [r.external_id, r.job_description]));
      assert.equal(map.get("j1"), "JD for j1");
      assert.equal(map.get("j2"), "JD for j2");
      assert.equal(map.get("j3"), null, "上游无 JD 的职位保持 NULL");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_details 同步：幂等跑两次，第二次 queried=0/matched=0，职位行数不变，sync_runs 两条",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-details-${marker}`,
      environment: "test",
      displayName: "Fixture Job Details Idempotency",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [{ externalId: "j1", ageDays: 9 }]);

      const callTool = async (_toolName, args) => jobsGetPage(args.job_id, "JD for j1");

      const first = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(first.status, "succeeded");
      assert.equal(first.stats.queried, 1);
      assert.equal(first.stats.detailsMatched, 1);

      // 第二次：JD 已补全，不再查询
      const second = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(second.status, "succeeded");
      assert.equal(second.stats.queried, 0, "已补 JD 的职位不再查询");
      assert.equal(second.stats.detailsMatched, 0);

      const [jobCount] = await sql`
        select count(*)::int as count from jobs
        where source_connection_id = ${sourceId}
      `;
      assert.equal(jobCount.count, 1, "职位行数不变");

      const runs = await sql`
        select sync_type, status from sync_runs
        where source_connection_id = ${sourceId} and sync_type = 'job_details_jobs'
        order by created_at
      `;
      assert.equal(runs.length, 2, "每次运行新增一条 job_details_jobs sync_run");
      assert.ok(runs.every((r) => r.status === "succeeded"));
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_details 同步：已有 JD 的职位不被查询（null 安全，不抹既有值）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-details-${marker}`,
      environment: "test",
      displayName: "Fixture Job Details Null Safety",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [{ externalId: "j1", ageDays: 9 }]);
      await sql`
        update jobs set job_description = 'existing JD'
        where source_connection_id = ${sourceId} and external_id = 'j1'
      `;

      // 已有 JD 的职位缺 JD 查询不可见 → 不调 jobs.get，JD 保留
      const callTool = async (_toolName, args) => jobsGetPage(args.job_id, "JD for j1");
      const outcome = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.queried, 0, "已有 JD 不查询");

      const [row] = await sql`
        select job_description from jobs
        where source_connection_id = ${sourceId} and external_id = 'j1'
      `;
      assert.equal(row.job_description, "existing JD", "既有 JD 不被覆盖");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_details 同步：单职位 jobs.get 失败仅计数 failed 并跳过，不毒化整轮",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-details-${marker}`,
      environment: "test",
      displayName: "Fixture Job Details Graceful",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [
        { externalId: "j1", ageDays: 9 },
        { externalId: "j2", ageDays: 12 },
      ]);

      // j1 的 get 失败（限流），j2 成功
      const callTool = async (_toolName, args) => {
        if (args.job_id === "j1") {
          throw new McpDiscoveryError("rate limited", {
            code: "RATE_LIMITED",
            retryable: true,
          });
        }
        return jobsGetPage(args.job_id, "JD for j2");
      };

      const outcome = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(outcome.status, "succeeded", "单职位失败不使整轮失败");
      assert.deepEqual(outcome.stats, {
        queried: 2,
        detailsMatched: 1,
        detailsMissing: 0,
        failed: 1,
      });

      const rows = await sql`
        select external_id, job_description
        from jobs where source_connection_id = ${sourceId} order by external_id
      `;
      const map = new Map(rows.map((r) => [r.external_id, r.job_description]));
      assert.equal(map.get("j1"), null, "失败职位保持缺 JD，下次同步补全");
      assert.equal(map.get("j2"), "JD for j2");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);
