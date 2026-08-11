import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

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

test(
  "同一来源职位重复同步更新业务记录且不保存明文原始载荷",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}`,
        environment: "test",
        displayName: "Fixture MCP",
      });
      const syncRunId = await startSyncRun(sql, sourceId, "under_served_jobs");
      const job = {
        externalId: "fixture-job-001",
        title: "Fixture Engineer",
        companyName: "Fixture Company Plaintext Marker",
        ownerExternalId: "fixture-owner",
        ownerName: "Fixture Owner",
        ageDays: 7,
        lastRecommendationAt: null,
        category: "Engineering",
        city: "Shanghai",
        salaryMin: 20,
        salaryMax: 30,
        portalUrl: "https://portal.invalid/jobs/fixture-job-001",
        sourceCreatedAt: null,
        eligibilityEvidence: {
          activeStatus: "provider_filter",
          zeroRecommendations: "provider_filter",
          age: "days_without_rec",
        },
      };

      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId,
        rawPayload: { job_id: job.externalId, secret_marker: job.companyName },
        job,
        encryption,
      });
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId,
        rawPayload: { job_id: job.externalId, secret_marker: job.companyName },
        job: { ...job, title: "Updated Fixture Engineer" },
        encryption,
      });
      await finishSyncRun(sql, syncRunId, { processed: 2, upserted: 1 });

      const replayRunId = await startSyncRun(
        sql,
        sourceId,
        "under_served_jobs",
      );
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: replayRunId,
        rawPayload: { job_id: job.externalId, secret_marker: job.companyName },
        job: { ...job, title: "Replay Fixture Engineer" },
        encryption,
      });
      await finishSyncRun(sql, replayRunId, { processed: 1, upserted: 1 });

      const [jobCount] = await sql`
        select count(*)::int as count, max(title) as title
        from jobs
        where source_connection_id = ${sourceId}
          and external_id = ${job.externalId}
      `;
      assert.deepEqual(
        { ...jobCount },
        { count: 1, title: "Replay Fixture Engineer" },
      );

      const records = await sql`
        select payload_ciphertext, processing_status
        from raw_records
        where source_connection_id = ${sourceId}
      `;
      assert.equal(records.length, 2);
      assert.equal(records[0].processing_status, "normalized");
      assert.equal(
        records[0].payload_ciphertext.includes(
          Buffer.from("Fixture Company Plaintext Marker"),
        ),
        false,
      );
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
