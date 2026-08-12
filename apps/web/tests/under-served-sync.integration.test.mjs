import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { runUnderServedSync } from "../lib/jobs/under-served-sync.mjs";

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
