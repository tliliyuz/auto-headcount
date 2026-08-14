import { encryptJsonPayload } from "../security/payload-encryption.mjs";

/** 浏览器候选人批次仓储：批次/数字断点/唯一条目与详情任务在事务内建立（docs/10 §5）。 */
export function createBrowserCandidateBatchRepository(sql) {
  return {
    async createAndEnqueue({ payload, scheduledAt }) {
      return sql.begin(async (tx) => {
        const active = await tx`
          select id from browser_candidate_batches
          where source_connection_id = ${payload.sourceConnectionId}
            and user_id = ${payload.userId} and device_id = ${payload.deviceId}
            and status in ('pending', 'discovering', 'collecting')
          order by created_at limit 1
        `;
        if (active[0]) {
          const task = await tx`
            select id from async_tasks
            where kind = 'browser_candidate_discovery'
              and payload->>'batchId' = ${active[0].id}
              and status in ('pending', 'running')
            order by created_at limit 1
          `;
          return { accepted: false, deduplicated: true, batchId: active[0].id, taskId: task[0]?.id ?? null };
        }
        const [batch] = await tx`
          insert into browser_candidate_batches (
            source_connection_id, user_id, device_id, contract_id,
            batch_size, max_pages, start_page, start_offset, status
          ) values (
            ${payload.sourceConnectionId}, ${payload.userId}, ${payload.deviceId}, ${payload.contractId},
            ${payload.batchSize}, ${payload.maxPages}, ${payload.startPage ?? null}, ${payload.startOffset ?? null}, 'pending'
          ) returning id
        `;
        const taskPayload = { batchId: batch.id, ...payload };
        const [task] = await tx`
          insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
          values ('browser_candidate_discovery', ${`browser-candidate-discovery:${batch.id}`}, ${tx.json(taskPayload)}, ${scheduledAt})
          returning id
        `;
        return { accepted: true, deduplicated: false, batchId: batch.id, taskId: task.id };
      });
    },

    async sourceExists(sourceConnectionId) {
      const rows = await sql`select 1 from source_connections where id = ${sourceConnectionId} and status = 'active' limit 1`;
      return rows.length === 1;
    },

    /** 差分采集已知集合：该来源 `candidates` 已入库的 externalId → 标题（current_title 优先，回退 seniority），供发现阶段跳过未变候选人。 */
    async findKnownCandidates({ sourceConnectionId }) {
      const rows = await sql`
        select c.external_id, p.current_title, p.seniority
        from candidates c
        left join candidate_profiles p on p.candidate_id = c.id
        where c.source_connection_id = ${sourceConnectionId}
      `;
      return rows.map((row) => ({
        candidateId: row.external_id,
        title: row.current_title ?? row.seniority ?? null,
      }));
    },

    /** 候选人批次列表（管理端「最近采集批次」）：按创建时间倒序。 */
    async listBatches({ page = 1, pageSize = 10 }) {
      const [{ total }] = await sql`
        select count(*)::int as total from browser_candidate_batches
      `;
      const list = await sql`
        select
          id,
          source_connection_id as "sourceConnectionId",
          batch_size as "batchSize",
          max_pages as "maxPages",
          status,
          discovered_count as "discoveredCount",
          succeeded_count as "succeededCount",
          skipped_count as "skippedCount",
          failed_count as "failedCount",
          stop_reason as "stopReason",
          created_at as "createdAt",
          finished_at as "finishedAt"
        from browser_candidate_batches
        order by created_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return { total, page, pageSize, totalPages: Math.ceil(total / pageSize), list };
    },

    async persistDiscovery({ batch, discovery, detailContractId }) {
      return sql.begin(async (tx) => {
        let createdItems = 0;
        let enqueuedDetails = 0;
        for (const item of discovery.items) {
          const rows = await tx`
            insert into browser_candidate_items (batch_id, external_id, title, page_number, position)
            values (${batch.batchId}, ${item.candidateId}, ${item.title}, ${item.pageNumber}, ${item.position})
            on conflict (batch_id, external_id) do nothing
            returning id
          `;
          if (!rows[0]) continue;
          createdItems += 1;
          const detailPayload = {
            collectionBatchId: batch.batchId,
            collectionItemId: rows[0].id,
            sourceConnectionId: batch.sourceConnectionId,
            userId: batch.userId,
            deviceId: batch.deviceId,
            contractId: detailContractId,
            externalId: item.candidateId,
            expectedTitle: item.title,
          };
          const tasks = await tx`
            insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
            values ('browser_candidate_collect', ${`browser-candidate-collect:batch:${batch.batchId}:${item.candidateId}`}, ${tx.json(detailPayload)}, now())
            on conflict (idempotency_key) do nothing returning id
          `;
          if (tasks[0]) enqueuedDetails += 1;
        }
        await tx`
          update browser_candidate_batches
          set status = case
                when (select count(*) from browser_candidate_items where batch_id = ${batch.batchId}) = 0
                  then 'succeeded'
                else 'collecting'
              end,
              discovered_count = (select count(*)::int from browser_candidate_items where batch_id = ${batch.batchId}),
              next_page = ${discovery.nextPage}, next_offset = ${discovery.nextOffset}, stop_reason = ${discovery.stopReason},
              finished_at = case
                when (select count(*) from browser_candidate_items where batch_id = ${batch.batchId}) = 0
                  then now()
                else null
              end,
              updated_at = now()
          where id = ${batch.batchId}
        `;
        return { createdItems, enqueuedDetails, batchId: batch.batchId };
      });
    },
  };
}

export async function updateBrowserCandidateItemOutcome(sql, payload, outcome, decision, now) {
  if (!payload?.collectionBatchId || !payload?.collectionItemId) return;
  let status = "pending";
  if (decision === "succeeded") status = outcome.stats?.persisted === 1 ? "succeeded" : "skipped";
  else if (decision === "failed" || decision === "dead") status = "failed";
  await sql.begin(async (tx) => {
    await tx`
      update browser_candidate_items
      set status = ${status}, last_error_code = ${outcome.errorCode ?? outcome.skipReason ?? null},
          finished_at = ${status === "pending" ? null : now}, updated_at = now()
      where id = ${payload.collectionItemId} and batch_id = ${payload.collectionBatchId}
    `;
    await tx`
      update browser_candidate_batches b set
        succeeded_count = s.succeeded_count,
        skipped_count = s.skipped_count,
        failed_count = s.failed_count,
        status = case when s.pending_count = 0 then case when s.failed_count > 0 then 'completed_with_errors' else 'succeeded' end else 'collecting' end,
        finished_at = case when s.pending_count = 0 then ${now} else null end,
        updated_at = now()
      from (
        select batch_id,
          count(*) filter (where status = 'succeeded')::int as succeeded_count,
          count(*) filter (where status = 'skipped')::int as skipped_count,
          count(*) filter (where status = 'failed')::int as failed_count,
          count(*) filter (where status = 'pending')::int as pending_count
        from browser_candidate_items where batch_id = ${payload.collectionBatchId} group by batch_id
      ) s where b.id = s.batch_id
    `;
  });
}

export async function updateBrowserCandidateBatchDiscoveryOutcome(sql, payload, outcome, decision, now) {
  if (!payload?.batchId || payload?.contractId !== "liebide-talent-pool-list-v1") return;
  if (decision === "succeeded") return;
  const status = decision === "retry" ? "pending" : "failed";
  await sql`
    update browser_candidate_batches
    set status = ${status}, stop_reason = ${outcome.errorCode ?? null},
        finished_at = ${status === "failed" ? now : null}, updated_at = now()
    where id = ${payload.batchId}
  `;
}

export function createBrowserCandidateCollectionRepository(sql, { encryption }) {
  return {
    async sourceExists(sourceConnectionId) {
      const rows = await sql`
        select 1 from source_connections
        where id = ${sourceConnectionId} and status = 'active'
        limit 1
      `;
      return rows.length === 1;
    },

    async persist({ sourceConnectionId, contractId, record, candidate, profile }) {
      return sql.begin(async (tx) => {
        const encrypted = await encryptJsonPayload(record, encryption);
        const [syncRun] = await tx`
          insert into sync_runs (source_connection_id, sync_type, status, started_at)
          values (${sourceConnectionId}, 'browser_candidate_collect', 'running', now())
          returning id
        `;
        const [rawRecord] = await tx`
          insert into raw_records (
            sync_run_id, source_connection_id, entity_type, external_id,
            schema_version, payload_ciphertext, payload_nonce, key_version,
            payload_hash, processing_status, captured_at
          ) values (
            ${syncRun.id}, ${sourceConnectionId}, 'candidate', ${candidate.externalId},
            ${contractId}, ${encrypted.ciphertext}, ${encrypted.nonce},
            ${encrypted.keyVersion}, ${encrypted.payloadHash}, 'normalized',
            ${new Date(record.capturedAt)}
          )
          returning id
        `;
        const [savedCandidate] = await tx`
          insert into candidates (
            source_connection_id, raw_record_id, external_id, display_name, summary
          ) values (
            ${sourceConnectionId}, ${rawRecord.id}, ${candidate.externalId}, ${candidate.displayName}, ${candidate.summary ?? null}
          )
          on conflict (source_connection_id, external_id)
          do update set
            raw_record_id = excluded.raw_record_id,
            display_name = excluded.display_name,
            summary = coalesce(excluded.summary, candidates.summary),
            updated_at = now()
          returning id
        `;
        await tx`
          insert into candidate_profiles (
            candidate_id, experience_years, location, education, seniority, industry,
            current_title, current_company, activity_updated_at
          ) values (
            ${savedCandidate.id}, ${profile.experienceYears ?? null}, ${profile.location ?? null},
            ${profile.education ?? null}, ${profile.seniority ?? null}, ${profile.industry ?? null},
            ${profile.currentTitle ?? null}, ${profile.currentCompany ?? null},
            ${profile.activityUpdatedAt ? new Date(profile.activityUpdatedAt) : null}
          )
          on conflict (candidate_id)
          do update set
            experience_years = excluded.experience_years,
            location = excluded.location,
            education = excluded.education,
            seniority = excluded.seniority,
            industry = excluded.industry,
            current_title = excluded.current_title,
            current_company = excluded.current_company,
            activity_updated_at = excluded.activity_updated_at,
            updated_at = now()
        `;
        await tx`
          update sync_runs
          set status = 'succeeded',
              stats = ${tx.json({ extracted: 1, eligible: 1, persisted: 1, skipped: 0 })},
              finished_at = now()
          where id = ${syncRun.id}
        `;
        return { syncRunId: syncRun.id, rawRecordId: rawRecord.id, candidateId: savedCandidate.id };
      });
    },
  };
}
