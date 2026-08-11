import { encryptJsonPayload } from "../security/payload-encryption.mjs";

export async function getOrCreateSourceConnection(
  sql,
  { provider, environment, displayName },
) {
  const [row] = await sql`
    insert into source_connections (provider, environment, status, display_name)
    values (${provider}, ${environment}, 'active', ${displayName})
    on conflict (provider, environment)
    do update set
      display_name = excluded.display_name,
      updated_at = now()
    returning id
  `;
  return row.id;
}

export async function startSyncRun(sql, sourceId, syncType) {
  const [row] = await sql`
    insert into sync_runs (source_connection_id, sync_type, status, started_at)
    values (${sourceId}, ${syncType}, 'running', now())
    returning id
  `;
  return row.id;
}

export async function persistUnderServedJob(
  sql,
  { sourceId, syncRunId, rawPayload, job, encryption },
) {
  const encrypted = await encryptJsonPayload(rawPayload, encryption);
  const [rawRecord] = await sql`
    insert into raw_records (
      sync_run_id,
      source_connection_id,
      entity_type,
      external_id,
      schema_version,
      payload_ciphertext,
      payload_nonce,
      key_version,
      payload_hash,
      processing_status
    ) values (
      ${syncRunId},
      ${sourceId},
      'job',
      ${job.externalId},
      'under-served-v1',
      ${encrypted.ciphertext},
      ${encrypted.nonce},
      ${encrypted.keyVersion},
      ${encrypted.payloadHash},
      'normalized'
    )
    on conflict (source_connection_id, external_id, payload_hash, sync_run_id)
    do update set payload_hash = excluded.payload_hash
    returning id
  `;

  const [savedJob] = await sql`
    insert into jobs (
      source_connection_id,
      raw_record_id,
      external_id,
      mapping_version,
      title,
      company_name,
      category,
      city,
      salary_min,
      salary_max,
      status,
      published_at,
      days_without_recommendation,
      valid_recommendation_count,
      eligibility_evidence,
      portal_url,
      source_updated_at
    ) values (
      ${sourceId},
      ${rawRecord.id},
      ${job.externalId},
      'under-served-v1',
      ${job.title},
      ${job.companyName},
      ${job.category},
      ${job.city},
      ${job.salaryMin},
      ${job.salaryMax},
      'active',
      ${job.sourceCreatedAt},
      ${job.ageDays},
      ${null},
      ${JSON.stringify(job.eligibilityEvidence)}::jsonb,
      ${job.portalUrl},
      ${job.sourceCreatedAt}
    )
    on conflict (source_connection_id, external_id)
    do update set
      raw_record_id = excluded.raw_record_id,
      mapping_version = excluded.mapping_version,
      title = excluded.title,
      company_name = excluded.company_name,
      category = excluded.category,
      city = excluded.city,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      status = excluded.status,
      published_at = excluded.published_at,
      days_without_recommendation = excluded.days_without_recommendation,
      valid_recommendation_count = excluded.valid_recommendation_count,
      eligibility_evidence = excluded.eligibility_evidence,
      portal_url = excluded.portal_url,
      source_updated_at = excluded.source_updated_at,
      updated_at = now()
    returning id
  `;

  return { rawRecordId: rawRecord.id, jobId: savedJob.id };
}

export async function finishSyncRun(sql, syncRunId, stats) {
  await sql`
    update sync_runs
    set status = 'succeeded', stats = ${JSON.stringify(stats)}::jsonb, finished_at = now()
    where id = ${syncRunId}
  `;
}
