import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

test(
  "PostgreSQL 迁移可运行，密文使用 bytea，来源职位保持幂等",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    let syncRunId;
    let rawRecordId;

    try {
      const tables = await sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in ('source_connections', 'sync_runs', 'raw_records', 'jobs')
        order by table_name
      `;
      assert.deepEqual(
        tables.map((row) => row.table_name),
        ["jobs", "raw_records", "source_connections", "sync_runs"],
      );

      const columns = await sql`
        select column_name, data_type
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'raw_records'
          and column_name in ('payload_ciphertext', 'payload_nonce')
        order by column_name
      `;
      assert.deepEqual(Array.from(columns), [
        { column_name: "payload_ciphertext", data_type: "bytea" },
        { column_name: "payload_nonce", data_type: "bytea" },
      ]);

      [{ id: sourceId }] = await sql`
        insert into source_connections (provider, environment, status, display_name)
        values (${`fixture-${marker}`}, 'test', 'active', 'Fixture MCP')
        returning id
      `;

      await assert.rejects(
        sql`
          insert into source_connections (provider, environment, status, display_name)
          values (${`fixture-${marker}`}, 'test', 'active', 'Duplicate Fixture MCP')
        `,
        (error) => error.code === "23505",
      );

      [{ id: syncRunId }] = await sql`
        insert into sync_runs (source_connection_id, sync_type, status)
        values (${sourceId}, 'under_served_jobs', 'running')
        returning id
      `;

      [{ id: rawRecordId }] = await sql`
        insert into raw_records (
          sync_run_id,
          source_connection_id,
          entity_type,
          external_id,
          schema_version,
          payload_ciphertext,
          payload_nonce,
          key_version,
          payload_hash
        ) values (
          ${syncRunId},
          ${sourceId},
          'job',
          'fixture-job-001',
          '2026-08-11',
          ${new Uint8Array([1, 2, 3])},
          ${new Uint8Array([4, 5, 6])},
          'fixture-key-v1',
          ${marker}
        )
        returning id
      `;

      const insertJob = () => sql`
        insert into jobs (
          source_connection_id,
          raw_record_id,
          external_id,
          mapping_version,
          title,
          company_name,
          category,
          city,
          status,
          days_without_recommendation,
          eligibility_evidence,
          portal_url
        ) values (
          ${sourceId},
          ${rawRecordId},
          'fixture-job-001',
          'v1',
          'Fixture Engineer',
          'Fixture Company',
          'Engineering',
          'Shanghai',
          'active',
          7,
          ${JSON.stringify({ activeStatus: "provider_filter" })}::jsonb,
          'https://portal.invalid/jobs/fixture-job-001'
        )
      `;

      await insertJob();
      await assert.rejects(insertJob(), (error) => error.code === "23505");
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
