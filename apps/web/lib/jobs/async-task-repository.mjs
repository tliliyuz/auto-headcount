/**
 * 异步任务仓储：async_tasks 表（数据库任务表调度，02-architecture §5）。
 *
 * - 幂等入队：`idempotency_key` 唯一，重复入队 `ON CONFLICT DO NOTHING`。
 * - 原子认领：`FOR UPDATE SKIP LOCKED` 避免并发 tick 重复处理同一任务。
 * - 状态流转：pending → running → succeeded/failed/dead，网络错误退避回 pending（next_attempt_at 门控）。
 * - `payload` 为白名单 jsonb（同步任务只含 source 身份），不存敏感字段。
 */

export function createAsyncTaskRepository(sql) {
  return {
    /** 幂等入队：已存在同 key 任务返回 null，新入队返回任务 id。 */
    async enqueueTask({ kind, idempotencyKey, payload, scheduledAt }) {
      const rows = await sql`
        insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
        values (${kind}, ${idempotencyKey}, ${sql.json(payload ?? {})}, ${scheduledAt})
        on conflict (idempotency_key) do nothing
        returning id
      `;
      return rows.length ? rows[0].id : null;
    },

    /** 认领到期 pending 任务（scheduled_at 到期且 next_attempt_at 放行），返回含 post-increment attempts。 */
    async claimDueTasks({ limit = 10, now }) {
      return sql`
        update async_tasks
        set status = 'running', attempts = attempts + 1,
            started_at = ${now}, updated_at = now()
        where id in (
          select id
          from async_tasks
          where status = 'pending'
            and scheduled_at <= ${now}
            and (next_attempt_at is null or next_attempt_at <= ${now})
          order by scheduled_at
          limit ${limit}
          for update skip locked
        )
        returning id, kind, payload, attempts
      `;
    },

    /** 终态：succeeded / failed / dead。 */
    async finishTask({ id, status, errorCode, finishedAt }) {
      await sql`
        update async_tasks
        set status = ${status},
            last_error_code = ${errorCode ?? null},
            finished_at = ${finishedAt ?? null},
            updated_at = now()
        where id = ${id}
      `;
    },

    /** 网络错误退避：回到 pending 并设 next_attempt_at 门控。 */
    async markPendingForRetry({ id, nextAttemptAt, errorCode }) {
      await sql`
        update async_tasks
        set status = 'pending',
            next_attempt_at = ${nextAttemptAt},
            last_error_code = ${errorCode ?? null},
            updated_at = now()
        where id = ${id}
      `;
    },
  };
}
