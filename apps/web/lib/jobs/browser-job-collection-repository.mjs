import { encryptJsonPayload } from "../security/payload-encryption.mjs";

export function createBrowserJobCollectionRepository(sql, { encryption }) {
  return {
    async sourceExists(sourceConnectionId) {
      const rows = await sql`
        select 1 from source_connections
        where id = ${sourceConnectionId} and status = 'active'
        limit 1
      `;
      return rows.length === 1;
    },

    async persist({ sourceConnectionId, contractId, record, job }) {
      return sql.begin(async (tx) => {
        const encrypted = await encryptJsonPayload(record, encryption);
        const [syncRun] = await tx`
          insert into sync_runs (source_connection_id, sync_type, status, started_at)
          values (${sourceConnectionId}, 'browser_job_collect', 'running', now())
          returning id
        `;
        const [rawRecord] = await tx`
          insert into raw_records (
            sync_run_id, source_connection_id, entity_type, external_id,
            schema_version, payload_ciphertext, payload_nonce, key_version,
            payload_hash, processing_status, captured_at
          ) values (
            ${syncRun.id}, ${sourceConnectionId}, 'job', ${job.externalId},
            ${contractId}, ${encrypted.ciphertext}, ${encrypted.nonce},
            ${encrypted.keyVersion}, ${encrypted.payloadHash}, 'normalized',
            ${new Date(record.capturedAt)}
          )
          returning id
        `;
        const [savedJob] = await tx`
          insert into jobs (
            source_connection_id, raw_record_id, external_id, mapping_version,
            title, company_name, category, city, job_description,
            salary_min, salary_max, status, published_at,
            days_without_recommendation, valid_recommendation_count,
            operability_status, eligibility_evidence, portal_url, source_updated_at
          ) values (
            ${sourceConnectionId}, ${rawRecord.id}, ${job.externalId}, 'browser-job-v1',
            ${job.title}, ${job.companyName}, ${job.category}, ${job.city},
            ${job.jobDescription}, ${job.salaryMin}, ${job.salaryMax}, ${job.status},
            ${new Date(job.publishedAt)}, ${job.ageDays}, ${job.validRecommendationCount},
            ${job.operabilityStatus}, ${tx.json(job.eligibilityEvidence)},
            ${job.portalUrl}, ${new Date(job.sourceUpdatedAt)}
          )
          on conflict (source_connection_id, external_id)
          do update set
            raw_record_id = excluded.raw_record_id,
            mapping_version = excluded.mapping_version,
            title = excluded.title,
            company_name = excluded.company_name,
            category = excluded.category,
            city = excluded.city,
            job_description = excluded.job_description,
            salary_min = excluded.salary_min,
            salary_max = excluded.salary_max,
            status = excluded.status,
            published_at = excluded.published_at,
            days_without_recommendation = excluded.days_without_recommendation,
            valid_recommendation_count = excluded.valid_recommendation_count,
            operability_status = excluded.operability_status,
            eligibility_evidence = excluded.eligibility_evidence,
            portal_url = excluded.portal_url,
            source_updated_at = excluded.source_updated_at,
            updated_at = now()
          returning id
        `;
        await tx`
          update sync_runs
          set status = 'succeeded',
              stats = ${tx.json({ extracted: 1, eligible: 1, persisted: 1, skipped: 0 })},
              finished_at = now()
          where id = ${syncRun.id}
        `;
        return { syncRunId: syncRun.id, rawRecordId: rawRecord.id, jobId: savedJob.id };
      });
    },
  };
}
