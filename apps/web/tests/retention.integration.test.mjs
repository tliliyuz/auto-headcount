import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { runRetention } from "../lib/jobs/retention.mjs";

const connectionString = process.env.DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;
const bytes = new Uint8Array([1, 2, 3]);

test(
  "保留清理按 TTL 删除过期数据、保留新数据并记录清理审计",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const now = new Date();
    const ago = (days) => new Date(now.getTime() - days * DAY);
    const later = (days) => new Date(now.getTime() + days * DAY);

    let sourceId;
    let orgId;
    let userId;

    try {
      const [source] = await sql`
        insert into source_connections (provider, environment, status, display_name)
        values (${`retention-fixture-${marker}`}, 'test', 'active', 'Retention Fixture')
        returning id
      `;
      sourceId = source.id;
      const [run] = await sql`
        insert into sync_runs (source_connection_id, sync_type, status)
        values (${sourceId}, 'under_served_jobs', 'succeeded')
        returning id
      `;
      const syncRunId = run.id;

      await sql`
        insert into raw_records (
          sync_run_id, source_connection_id, entity_type, external_id, schema_version,
          payload_ciphertext, payload_nonce, key_version, payload_hash, processing_status, captured_at
        ) values
          (${syncRunId}, ${sourceId}, 'job', ${`old-success-${marker}`}, 'under-served-v1', ${bytes}, ${bytes}, 'test-v1', 'h1', 'normalized', ${ago(40)}),
          (${syncRunId}, ${sourceId}, 'job', ${`old-invalid-${marker}`}, 'under-served-v1', ${bytes}, ${bytes}, 'test-v1', 'h2', 'invalid', ${ago(100)}),
          (${syncRunId}, ${sourceId}, 'job', ${`fresh-${marker}`}, 'under-served-v1', ${bytes}, ${bytes}, 'test-v1', 'h3', 'normalized', ${now})
      `;

      await sql`
        insert into jobs (
          source_connection_id, external_id, mapping_version, title, company_name, category, city,
          status, days_without_recommendation, eligibility_evidence, portal_url, updated_at
        ) values
          (${sourceId}, ${`old-closed-${marker}`}, 'under-served-v1', 'Old Closed', 'Co', 'Engineering', 'Shanghai', 'closed', 7, ${sql.json({})}, 'https://portal.invalid/x', ${ago(200)}),
          (${sourceId}, ${`fresh-active-${marker}`}, 'under-served-v1', 'Fresh Active', 'Co', 'Engineering', 'Shanghai', 'active', 7, ${sql.json({})}, 'https://portal.invalid/y', ${now})
      `;

      const [org] = await sql`
        insert into organizations (name) values (${`ret-org-${marker}`}) returning id
      `;
      orgId = org.id;
      const [user] = await sql`
        insert into users (organization_id, username, status, display_name, password_hash)
        values (${orgId}, ${`ret-user-${marker}`}, 'active', 'Retention User', 'not-a-real-hash')
        returning id
      `;
      userId = user.id;

      await sql`
        insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
        values
          (${userId}, ${`expired-${marker}`}, ${ago(1)}, ${ago(1)}),
          (${userId}, ${`active-${marker}`}, ${later(1)}, ${later(1)})
      `;

      await sql`
        insert into audit_logs (actor_type, action, result, occurred_at, metadata)
        values
          ('test', 'test.retention.fixture', 'success', ${ago(400)}, ${sql.json({ marker })}),
          ('test', 'test.retention.fixture', 'success', ${now}, ${sql.json({ marker })})
      `;

      const outcome = await runRetention({
        sql,
        now,
        requestId: marker,
        ttl: {
          rawSuccessDays: 30,
          rawExceptionDays: 90,
          jobClosedDays: 180,
          auditDays: 365,
        },
      });

      assert.equal(outcome.status, "succeeded");
      // 共享 dev DB 可能含其他过期数据（如遗留会话），全局计数按至少删除本夹具行断言；
      // 夹具范围内「旧删新留」由下面的按 source/user 精确查询保证。
      assert.ok(outcome.counts.rawRecordsDeleted >= 2);
      assert.ok(outcome.counts.jobsDeleted >= 1);
      assert.ok(outcome.counts.sessionsDeleted >= 1);
      assert.ok(outcome.counts.auditLogsDeleted >= 1);

      const raw = await sql`
        select external_id from raw_records where source_connection_id = ${sourceId}
      `;
      assert.deepEqual(
        raw.map((row) => row.external_id),
        [`fresh-${marker}`],
      );

      const jobs = await sql`
        select external_id from jobs where source_connection_id = ${sourceId}
      `;
      assert.deepEqual(
        jobs.map((row) => row.external_id),
        [`fresh-active-${marker}`],
      );

      const sessions = await sql`
        select token_hash from sessions where user_id = ${userId}
      `;
      assert.deepEqual(
        sessions.map((row) => row.token_hash),
        [`active-${marker}`],
      );

      const audit = await sql`
        select action, result, request_id, metadata
        from audit_logs
        where (action = 'test.retention.fixture' and metadata->>'marker' = ${marker})
           or (action = 'retention.run' and request_id = ${marker})
        order by occurred_at
      `;
      assert.deepEqual(
        audit.map((row) => row.action),
        ["test.retention.fixture", "retention.run"],
      );
      const retentionAudit = audit.find((row) => row.action === "retention.run");
      assert.equal(retentionAudit.result, "success");
      assert.equal(retentionAudit.request_id, marker);
      assert.ok(retentionAudit.metadata.rawRecordsDeleted >= 2);
      assert.ok(retentionAudit.metadata.jobsDeleted >= 1);
      assert.ok(retentionAudit.metadata.sessionsDeleted >= 1);
      assert.ok(retentionAudit.metadata.auditLogsDeleted >= 1);
    } finally {
      if (userId) {
        await sql`
          delete from audit_logs
          where (action = 'test.retention.fixture' and metadata->>'marker' = ${marker})
             or (action = 'retention.run' and request_id = ${marker})
        `;
        await sql`delete from sessions where user_id = ${userId}`;
        await sql`delete from users where id = ${userId}`;
      }
      if (orgId) await sql`delete from organizations where id = ${orgId}`;
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
