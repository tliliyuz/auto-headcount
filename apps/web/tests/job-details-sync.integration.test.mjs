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

function jobsListPage(list) {
  const payload = {
    Code: 0,
    Message: "success",
    Data: {
      total: list.length,
      page: 1,
      page_size: list.length || 1,
      total_pages: 1,
      list,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function jobsListItem(externalId, jobDescription) {
  return {
    job_id: externalId,
    job_title: `Job ${externalId}`,
    category: "Engineering",
    client_company: "Fixture Company",
    customer_name: "Fixture Customer",
    department_path: "Eng/Platform",
    job_description: jobDescription,
    salary: "20-30K",
    city: "Shanghai",
    created_by: "Fixture Recruiter",
    status: "active",
    portal_url: `https://portal.invalid/jobs/${externalId}`,
  };
}

async function seedJobs(sql, sourceId, specs) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  for (const spec of specs) {
    await persistUnderServedJob(sql, {
      sourceId,
      syncRunId: runId,
      rawPayload: { job_id: spec.externalId },
      job: fixtureJob(spec.externalId, spec.ageDays),
      encryption,
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
  "job_details 同步：wb.jobs.list 补全 job_description，命中/缺失计数正确",
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
      // 三条在职职位；wb.jobs.list 只返回 j1/j2（j3 缺失），另返回库中没有的 j4
      await seedJobs(sql, sourceId, [
        { externalId: "j1", ageDays: 9 },
        { externalId: "j2", ageDays: 12 },
        { externalId: "j3", ageDays: 15 },
      ]);

      let calls = 0;
      const callTool = async (toolName, args) => {
        calls += 1;
        assert.equal(toolName, "wb.jobs.list");
        assert.equal(args.page_size, 2);
        return jobsListPage([
          jobsListItem("j1", "JD for j1"),
          jobsListItem("j2", "JD for j2"),
          jobsListItem("j4", "JD for j4"),
        ]);
      };

      const outcome = await runJobDetailsSync({
        sql,
        source,
        pageSize: 2,
        mcp: { callTool },
      });
      sourceId = outcome.sourceId;
      assert.equal(outcome.status, "succeeded");
      assert.deepEqual(outcome.stats, {
        pages: 1,
        seen: 3,
        detailsSeen: 3,
        detailsMatched: 2,
        detailsMissing: 1,
      });

      const rows = await sql`
        select external_id, job_description
        from jobs
        where source_connection_id = ${sourceId}
        order by external_id
      `;
      const map = new Map(rows.map((r) => [r.external_id, r.job_description]));
      assert.equal(map.get("j1"), "JD for j1");
      assert.equal(map.get("j2"), "JD for j2");
      assert.equal(map.get("j3"), null, "wb.jobs.list 未返回的职位保持 NULL");
      assert.equal(calls, 1);
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_details 同步：幂等跑两次，第二次 detailsMatched=0，职位行数不变，sync_runs 两条",
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

      const callTool = async () =>
        jobsListPage([jobsListItem("j1", "JD for j1")]);

      const first = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(first.status, "succeeded");
      assert.equal(first.stats.detailsMatched, 1);

      const second = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(second.status, "succeeded");
      assert.equal(
        second.stats.detailsMatched,
        0,
        "描述已一致时 IS DISTINCT FROM 应跳过更新",
      );

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
  "job_details 同步：源 job_description 为空不抹除既有 JD（null 安全）",
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

      // 源返回 job_description = null
      const callTool = async () =>
        jobsListPage([jobsListItem("j1", null)]);

      const outcome = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.detailsMatched, 0, "null 不应视为变更");

      const [row] = await sql`
        select job_description from jobs
        where source_connection_id = ${sourceId} and external_id = 'j1'
      `;
      assert.equal(row.job_description, "existing JD", "源缺失不应抹除既有 JD");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_details 同步：wb.jobs.list 失败 → 运行标记失败，仅记录机器可读错误码",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-details-${marker}`,
      environment: "test",
      displayName: "Fixture Job Details Failure",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [{ externalId: "j1", ageDays: 9 }]);

      const callTool = async () => {
        throw new McpDiscoveryError("rate limited", {
          code: "RATE_LIMITED",
          retryable: true,
        });
      };

      const outcome = await runJobDetailsSync({ sql, source, mcp: { callTool } });
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.errorCode, "RATE_LIMITED");
      assert.equal(outcome.retryable, true);

      const [run] = await sql`
        select status, error_code from sync_runs
        where id = ${outcome.syncRunId}
      `;
      assert.equal(run.status, "failed");
      assert.equal(run.error_code, "RATE_LIMITED");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);
