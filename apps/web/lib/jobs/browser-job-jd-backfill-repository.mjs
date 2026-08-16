import { encryptJsonPayload } from "../security/payload-encryption.mjs";

/**
 * JD 回填仓储：浏览器详情（liebide-job-detail-v2）回填可操作职位 `job_description` 的持久化。
 *
 * - 只补 JD：更新只写 `job_description`（null-safe、不 bump updated_at、不碰其他列），
 *   不创建职位行、不改变 eligibility/status（沉睡与零推荐仍由 MCP 证明）。
 * - 每次浏览器详情回执都加密写入 raw_records（追加写，schema_version=契约 id）作为追溯证据。
 * - `job_jd_backfills` 台账记录 outcome=filled/no_provider_jd/failed，入队器据此排除已尝试职位。
 */
export function createBrowserJobJdBackfillRepository(sql, { encryption }) {
  return {
    async sourceExists(sourceConnectionId) {
      const rows = await sql`
        select 1 from source_connections
        where id = ${sourceConnectionId} and status = 'active'
        limit 1
      `;
      return rows.length === 1;
    },

    /** 抓到 JD：加密回执 → raw_records → null-safe 更新 job_description → 台账 filled。 */
    async persistFilled({ sourceConnectionId, contractId, jobId, externalId, record }) {
      return sql.begin(async (tx) => {
        const encrypted = await encryptJsonPayload(record, encryption);
        const [syncRun] = await tx`
          insert into sync_runs (source_connection_id, sync_type, status, started_at)
          values (${sourceConnectionId}, 'browser_job_jd_backfill', 'running', now())
          returning id
        `;
        const [rawRecord] = await tx`
          insert into raw_records (
            sync_run_id, source_connection_id, entity_type, external_id,
            schema_version, payload_ciphertext, payload_nonce, key_version,
            payload_hash, processing_status, captured_at
          ) values (
            ${syncRun.id}, ${sourceConnectionId}, 'job', ${externalId},
            ${contractId}, ${encrypted.ciphertext}, ${encrypted.nonce},
            ${encrypted.keyVersion}, ${encrypted.payloadHash}, 'normalized',
            ${new Date(record.capturedAt)}
          )
          returning id
        `;
        const updated = await tx`
          update jobs
          set job_description = ${record.jobDescription}
          where id = ${jobId}
            and source_connection_id = ${sourceConnectionId}
            and job_description is distinct from ${record.jobDescription}
        `;
        const [ledger] = await tx`
          insert into job_jd_backfills (
            job_id, source_connection_id, external_id, contract_id,
            outcome, jd_length, content_hash, raw_record_id
          ) values (
            ${jobId}, ${sourceConnectionId}, ${externalId}, ${contractId},
            'filled', ${record.jobDescription.length}, ${record.contentHash}, ${rawRecord.id}
          )
          returning id
        `;
        await tx`
          update sync_runs
          set status = 'succeeded',
              stats = ${tx.json({ extracted: 1, filled: 1, noProviderJd: 0, persisted: 1 })},
              finished_at = now()
          where id = ${syncRun.id}
        `;
        return {
          syncRunId: syncRun.id,
          rawRecordId: rawRecord.id,
          ledgerId: ledger.id,
          matched: Number(updated.count),
        };
      });
    },

    /** 供应方无 JD：加密回执 → raw_records → 台账 no_provider_jd（不更新 job_description）。 */
    async persistNoProviderJd({ sourceConnectionId, contractId, jobId, externalId, record }) {
      return sql.begin(async (tx) => {
        const encrypted = await encryptJsonPayload(record, encryption);
        const [syncRun] = await tx`
          insert into sync_runs (source_connection_id, sync_type, status, started_at)
          values (${sourceConnectionId}, 'browser_job_jd_backfill', 'running', now())
          returning id
        `;
        const [rawRecord] = await tx`
          insert into raw_records (
            sync_run_id, source_connection_id, entity_type, external_id,
            schema_version, payload_ciphertext, payload_nonce, key_version,
            payload_hash, processing_status, captured_at
          ) values (
            ${syncRun.id}, ${sourceConnectionId}, 'job', ${externalId},
            ${contractId}, ${encrypted.ciphertext}, ${encrypted.nonce},
            ${encrypted.keyVersion}, ${encrypted.payloadHash}, 'normalized',
            ${new Date(record.capturedAt)}
          )
          returning id
        `;
        const [ledger] = await tx`
          insert into job_jd_backfills (
            job_id, source_connection_id, external_id, contract_id,
            outcome, jd_length, content_hash, raw_record_id
          ) values (
            ${jobId}, ${sourceConnectionId}, ${externalId}, ${contractId},
            'no_provider_jd', 0, ${record.contentHash}, ${rawRecord.id}
          )
          returning id
        `;
        await tx`
          update sync_runs
          set status = 'succeeded',
              stats = ${tx.json({ extracted: 1, filled: 0, noProviderJd: 1, persisted: 1 })},
              finished_at = now()
          where id = ${syncRun.id}
        `;
        return { syncRunId: syncRun.id, rawRecordId: rawRecord.id, ledgerId: ledger.id, matched: 0 };
      });
    },

    /** 浏览器已就绪但回执/实体失败：写台账 failed（防下次手动扫描重复爬同一职位），不存回执。 */
    async persistFailed({ sourceConnectionId, contractId, jobId, externalId, errorCode }) {
      return sql.begin(async (tx) => {
        const [syncRun] = await tx`
          insert into sync_runs (source_connection_id, sync_type, status, started_at)
          values (${sourceConnectionId}, 'browser_job_jd_backfill', 'running', now())
          returning id
        `;
        const [ledger] = await tx`
          insert into job_jd_backfills (
            job_id, source_connection_id, external_id, contract_id,
            outcome, error_code
          ) values (
            ${jobId}, ${sourceConnectionId}, ${externalId}, ${contractId},
            'failed', ${errorCode}
          )
          returning id
        `;
        await tx`
          update sync_runs
          set status = 'failed',
              error_code = ${errorCode},
              stats = ${tx.json({ extracted: 0, filled: 0, noProviderJd: 0, persisted: 0 })},
              finished_at = now()
          where id = ${syncRun.id}
        `;
        return { syncRunId: syncRun.id, ledgerId: ledger.id };
      });
    },
  };
}

/** JD 回填台账分页读（只读，供管理端审计面板）：join jobs 取职位标题，可按 outcome 过滤。 */
export async function listJobJdBackfills(
  sql,
  { outcome, page = 1, pageSize = 20 } = {},
) {
  const where = sql`
    1 = 1
    ${outcome ? sql` and b.outcome = ${outcome}` : sql``}
  `;
  const [{ total }] = await sql`
    select count(*)::int as total
    from job_jd_backfills b
    where ${where}
  `;
  const list = await sql`
    select
      b.id,
      b.job_id as "jobId",
      b.source_connection_id as "sourceConnectionId",
      b.external_id as "externalId",
      j.title as "jobTitle",
      b.contract_id as "contractId",
      b.outcome,
      b.jd_length as "jdLength",
      b.content_hash as "contentHash",
      b.error_code as "errorCode",
      b.created_at as "createdAt"
    from job_jd_backfills b
    left join jobs j on j.id = b.job_id
    where ${where}
    order by b.created_at desc, b.id desc
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `;
  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    list,
  };
}
