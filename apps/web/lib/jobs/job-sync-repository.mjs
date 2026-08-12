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

/**
 * 同步看门狗：回收崩溃/超时残留的 `running` 运行（started_at 早于 staleBefore 的
 * 一律标记 failed + `RUN_STALE_TIMEOUT`），防止进程中断后 sync_run 永久卡 running。
 * 全局回收（不限来源）；仅由同步任务在开启新一轮前调用，正常 running 不受影响。
 */
export async function failStaleRunningSyncRuns(sql, { staleBefore }) {
  const result = await sql`
    update sync_runs
    set status = 'failed', error_code = 'RUN_STALE_TIMEOUT', finished_at = now()
    where status = 'running'
      and started_at < ${staleBefore}
  `;
  return Number(result.count);
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
      ${job.eligibilityEvidence},
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
      /* valid_recommendation_count 由推荐工作流维护，重同步不得用 NULL 覆盖既有计数 */
      eligibility_evidence = excluded.eligibility_evidence,
      portal_url = excluded.portal_url,
      source_updated_at = excluded.source_updated_at,
      updated_at = now()
    returning id
  `;

  return { rawRecordId: rawRecord.id, jobId: savedJob.id };
}

/**
 * 同步后关闭陈旧沉睡职位：本次全量同步未见（供应方已关闭/已有推荐/退出沉睡）的
 * active 且 7–30 天职位标记 `closed`，退出沉睡列表；retention 再按 TTL 清理 closed 行。
 * `activeExternalIds` 为本次同步实际写入的合格职位 externalId 集合；空数组表示
 * 供应方当前无任何沉睡职位（`<> all('{}')` 恒真，全部关闭）。
 */
export async function closeStaleUnderServedJobs(
  sql,
  { sourceId, activeExternalIds },
) {
  const ids = Array.isArray(activeExternalIds) ? activeExternalIds : [];
  const result = await sql`
    update jobs
    set status = 'closed', updated_at = now()
    where source_connection_id = ${sourceId}
      and status = 'active'
      and days_without_recommendation between 7 and 30
      and external_id <> all(${ids})
  `;
  return Number(result.count);
}

export async function finishSyncRun(sql, syncRunId, stats) {
  await sql`
    update sync_runs
    set status = 'succeeded', stats = ${stats}, finished_at = now()
    where id = ${syncRunId}
  `;
}

export async function failSyncRun(sql, syncRunId, errorCode, stats = {}) {
  await sql`
    update sync_runs
    set status = 'failed', error_code = ${errorCode}, stats = ${stats}, finished_at = now()
    where id = ${syncRunId}
  `;
}
