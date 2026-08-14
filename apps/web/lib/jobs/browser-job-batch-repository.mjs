/** 浏览器职位批次仓储：批次/数字断点/唯一条目与详情任务在事务内建立。 */
export function createBrowserJobBatchRepository(sql) {
  return {
    async createAndEnqueue({ payload, scheduledAt }) {
      return sql.begin(async (tx) => {
        const active = await tx`
          select id from browser_collection_batches
          where source_connection_id = ${payload.sourceConnectionId}
            and user_id = ${payload.userId} and device_id = ${payload.deviceId}
            and status in ('pending', 'discovering', 'collecting')
          order by created_at limit 1
        `;
        if (active[0]) {
          const task = await tx`
            select id from async_tasks
            where kind = 'browser_job_batch_discover'
              and payload->>'batchId' = ${active[0].id}
              and status in ('pending', 'running')
            order by created_at limit 1
          `;
          return { accepted: false, deduplicated: true, batchId: active[0].id, taskId: task[0]?.id ?? null };
        }
        const [batch] = await tx`
          insert into browser_collection_batches (
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
          values ('browser_job_batch_discover', ${`browser-job-batch-discover:${batch.id}`}, ${tx.json(taskPayload)}, ${scheduledAt})
          returning id
        `;
        return { accepted: true, deduplicated: false, batchId: batch.id, taskId: task.id };
      });
    },

    async sourceExists(sourceConnectionId) {
      const rows = await sql`select 1 from source_connections where id = ${sourceConnectionId} and status = 'active' limit 1`;
      return rows.length === 1;
    },

    async persistDiscovery({ batch, discovery, detailContractId }) {
      return sql.begin(async (tx) => {
        let createdItems = 0;
        let enqueuedDetails = 0;
        for (const item of discovery.items) {
          const rows = await tx`
            insert into browser_collection_items (batch_id, external_id, title, page_number, position)
            values (${batch.batchId}, ${item.externalId}, ${item.title}, ${item.pageNumber}, ${item.position})
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
            externalId: item.externalId,
          };
          const tasks = await tx`
            insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
            values ('browser_job_collect', ${`browser-job-collect:batch:${batch.batchId}:${item.externalId}`}, ${tx.json(detailPayload)}, now())
            on conflict (idempotency_key) do nothing returning id
          `;
          if (tasks[0]) enqueuedDetails += 1;
        }
        await tx`
          update browser_collection_batches
          set status = case
                when (select count(*) from browser_collection_items where batch_id = ${batch.batchId}) = 0
                  then 'succeeded'
                else 'collecting'
              end,
              discovered_count = (select count(*)::int from browser_collection_items where batch_id = ${batch.batchId}),
              next_page = ${discovery.nextPage}, next_offset = ${discovery.nextOffset}, stop_reason = ${discovery.stopReason},
              finished_at = case
                when (select count(*) from browser_collection_items where batch_id = ${batch.batchId}) = 0
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

export async function updateBrowserCollectionItemOutcome(sql, payload, outcome, decision, now) {
  if (!payload?.collectionBatchId || !payload?.collectionItemId) return;
  let status = "pending";
  if (decision === "succeeded") status = outcome.stats?.persisted === 1 ? "succeeded" : "skipped";
  else if (decision === "failed" || decision === "dead") status = "failed";
  await sql.begin(async (tx) => {
    await tx`
      update browser_collection_items
      set status = ${status}, last_error_code = ${outcome.errorCode ?? outcome.skipReason ?? null},
          finished_at = ${status === "pending" ? null : now}, updated_at = now()
      where id = ${payload.collectionItemId} and batch_id = ${payload.collectionBatchId}
    `;
    await tx`
      update browser_collection_batches b set
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
        from browser_collection_items where batch_id = ${payload.collectionBatchId} group by batch_id
      ) s where b.id = s.batch_id
    `;
  });
}

export async function updateBrowserCollectionBatchDiscoveryOutcome(sql, payload, outcome, decision, now) {
  if (!payload?.batchId || payload?.contractId !== "liebide-filtered-job-list-v2") return;
  if (decision === "succeeded") return;
  const status = decision === "retry" ? "pending" : "failed";
  await sql`
    update browser_collection_batches
    set status = ${status}, stop_reason = ${outcome.errorCode ?? null},
        finished_at = ${status === "failed" ? now : null}, updated_at = now()
    where id = ${payload.batchId}
  `;
}
