import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { runUnderServedSync } from "../lib/jobs/under-served-sync.mjs";
import { listUnderServedJobs } from "../lib/jobs/job-read-repository.mjs";
import {
  getOrCreateSourceConnection,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

function fakePage({ total, page, pageSize, totalPages, list }) {
  const payload = {
    Code: 0,
    Message: "success",
    Data: { total, page, page_size: pageSize, total_pages: totalPages, list },
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fakeJob(externalId, ageDays, companyMarker) {
  return {
    job_id: externalId,
    job_title: `Job ${externalId}`,
    client_company: companyMarker,
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

test(
  "两页分页同步：合格职位入库、原始快照加密追加写、重跑不产生重复职位",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-sync-${marker}`,
      environment: "test",
      displayName: "Fixture Under Served Sync",
    };
    let sourceId;

    try {
      const page1 = fakePage({
        total: 3,
        page: 1,
        pageSize: 2,
        totalPages: 2,
        list: [
          fakeJob("day-7", 7, "SECRET_COMPANY_MARKER_A"),
          fakeJob("day-31", 31, "SECRET_COMPANY_MARKER_B"),
        ],
      });
      const page2 = fakePage({
        total: 3,
        page: 2,
        pageSize: 2,
        totalPages: 2,
        list: [fakeJob("day-30", 30, "SECRET_COMPANY_MARKER_C")],
      });
      let calls = 0;
      const callTool = async (toolName, args) => {
        calls += 1;
        assert.equal(toolName, "wb.jobs.under_served");
        assert.equal(args.days_without_rec, 7);
        assert.equal(args.page_size, 2);
        return args.page === 1 ? page1 : page2;
      };

      const first = await runUnderServedSync({
        sql,
        encryption,
        source,
        pageSize: 2,
        mcp: { callTool },
      });
      sourceId = first.sourceId;
      assert.equal(first.status, "succeeded");
      assert.deepEqual(first.stats, {
        pages: 2,
        seen: 3,
        eligible: 2,
        skipped: 1,
        persisted: 2,
        closedStale: 0,
      });

      const jobsAfterFirst = await sql`
        select external_id, raw_record_id
        from jobs
        where source_connection_id = ${sourceId}
        order by external_id
      `;
      assert.deepEqual(
        jobsAfterFirst.map((row) => row.external_id),
        ["day-30", "day-7"],
      );
      assert.equal(jobsAfterFirst[0].raw_record_id !== null, true);

      const rawAfterFirst = await sql`
        select external_id, payload_ciphertext, processing_status, schema_version
        from raw_records
        where source_connection_id = ${sourceId}
        order by external_id
      `;
      assert.equal(rawAfterFirst.length, 2);
      assert.ok(
        rawAfterFirst.every(
          (row) =>
            row.processing_status === "normalized" &&
            row.schema_version === "under-served-v1",
        ),
      );
      for (const row of rawAfterFirst) {
        const plaintext = Buffer.from(row.payload_ciphertext).toString("utf8");
        assert.equal(
          plaintext.includes(
            row.external_id === "day-7"
              ? "SECRET_COMPANY_MARKER_A"
              : "SECRET_COMPANY_MARKER_C",
          ),
          false,
          `${row.external_id} raw snapshot must not store plaintext`,
        );
      }

      const second = await runUnderServedSync({
        sql,
        encryption,
        source,
        pageSize: 2,
        mcp: { callTool },
      });
      assert.equal(second.status, "succeeded");

      const jobsAfterSecond = await sql`
        select count(*)::int as count
        from jobs
        where source_connection_id = ${sourceId}
      `;
      assert.equal(jobsAfterSecond[0].count, 2);

      const rawAfterSecond = await sql`
        select payload_ciphertext, external_id
        from raw_records
        where source_connection_id = ${sourceId}
      `;
      assert.equal(rawAfterSecond.length, 4);
      for (const row of rawAfterSecond) {
        const plaintext = Buffer.from(row.payload_ciphertext).toString("utf8");
        assert.equal(
          /SECRET_COMPANY_MARKER_[ABC]/.test(plaintext),
          false,
          "re-run snapshots must remain encrypted",
        );
      }

      const runs = await sql`
        select status
        from sync_runs
        where source_connection_id = ${sourceId}
        order by created_at
      `;
      assert.deepEqual(
        runs.map((row) => row.status),
        ["succeeded", "succeeded"],
      );
      assert.equal(calls, 4);
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
  "MCP 限流错误：同步运行标记失败，仅记录机器可读错误码，不落原始错误或凭据",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-sync-${marker}`,
      environment: "test",
      displayName: "Fixture Under Served Sync",
    };
    let sourceId;

    try {
      const callTool = async () => {
        throw new McpDiscoveryError("rate limited", {
          code: "RATE_LIMITED",
          retryable: true,
        });
      };

      const outcome = await runUnderServedSync({
        sql,
        encryption,
        source,
        mcp: { callTool },
      });
      sourceId = outcome.sourceId;
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.errorCode, "RATE_LIMITED");

      const [run] = await sql`
        select status, error_code, finished_at, stats
        from sync_runs
        where id = ${outcome.syncRunId}
      `;
      assert.equal(run.status, "failed");
      assert.equal(run.error_code, "RATE_LIMITED");
      assert.notEqual(run.finished_at, null);

      const serialized = JSON.stringify({ ...run, finished_at: "ts" });
      assert.equal(
        serialized.toLowerCase().includes("rate limited"),
        false,
        "error message must not be persisted",
      );

      const [jobCount] = await sql`
        select count(*)::int as count
        from jobs
        where source_connection_id = ${sourceId}
      `;
      const [rawCount] = await sql`
        select count(*)::int as count
        from raw_records
        where source_connection_id = ${sourceId}
      `;
      assert.equal(jobCount.count, 0);
      assert.equal(rawCount.count, 0);
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
  "同步后关闭陈旧沉睡职位：供应方列表消失的职位标记 closed，退出沉睡列表",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-sync-${marker}`,
      environment: "test",
      displayName: "Fixture Under Served Sync",
    };
    let sourceId;

    try {
      // 首次：供应方返回 alpha + beta 两个合格职位
      const firstPage = fakePage({
        total: 2,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        list: [fakeJob("alpha", 9, "SECRET_COMPANY_MARKER_A"), fakeJob("beta", 12, "SECRET_COMPANY_MARKER_B")],
      });
      const first = await runUnderServedSync({
        sql,
        encryption,
        source,
        pageSize: 20,
        mcp: { callTool: async () => firstPage },
      });
      sourceId = first.sourceId;
      assert.equal(first.status, "succeeded");
      assert.equal(first.stats.closedStale, 0);

      // 第二次：beta 从供应方列表消失（已关闭/已有推荐）
      const secondPage = fakePage({
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        list: [fakeJob("alpha", 10, "SECRET_COMPANY_MARKER_A")],
      });
      const second = await runUnderServedSync({
        sql,
        encryption,
        source,
        pageSize: 20,
        mcp: { callTool: async () => secondPage },
      });
      assert.equal(second.status, "succeeded");
      assert.equal(second.stats.closedStale, 1, "beta 应被标记 closed");

      const rows = await sql`
        select external_id, status
        from jobs
        where source_connection_id = ${sourceId}
        order by external_id
      `;
      assert.deepEqual(
        rows.map((r) => [r.external_id, r.status]),
        [
          ["alpha", "active"],
          ["beta", "closed"],
        ],
      );

      // beta 不再出现在沉睡列表
      const dormant = await listUnderServedJobs(sql, { pageSize: 100 });
      const dormantBeta = dormant.list.some(
        (job) => job.externalId === "beta",
      );
      assert.equal(dormantBeta, false, "closed 职位不应进入沉睡列表");
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
  "同步看门狗：崩溃残留的 running 运行被回收为 RUN_STALE_TIMEOUT",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-sync-${marker}`,
      environment: "test",
      displayName: "Fixture Under Served Sync",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      // 直接插入一条卡住的 running 运行（1 小时前启动）
      const staleRunId = await startSyncRun(sql, sourceId, "under_served_jobs");
      await sql`
        update sync_runs
        set started_at = now() - interval '1 hour'
        where id = ${staleRunId}
      `;

      const emptyPage = fakePage({
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        list: [],
      });
      const outcome = await runUnderServedSync({
        sql,
        encryption,
        source,
        pageSize: 20,
        staleSyncRunMs: 5 * 60 * 1000,
        mcp: { callTool: async () => emptyPage },
      });
      assert.equal(outcome.status, "succeeded");

      const [staleRun] = await sql`
        select status, error_code, finished_at
        from sync_runs where id = ${staleRunId}
      `;
      assert.equal(staleRun.status, "failed", "卡住的 running 应被回收");
      assert.equal(staleRun.error_code, "RUN_STALE_TIMEOUT");
      assert.notEqual(staleRun.finished_at, null);
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
