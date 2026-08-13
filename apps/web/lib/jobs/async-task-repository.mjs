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

    /** 手动触发守卫：仅当同 kind 无活跃（pending/running）任务时原子入队；被拦截返回 null。 */
    async enqueueTaskIfIdle({ kind, idempotencyKey, payload, scheduledAt }) {
      const rows = await sql`
        insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
        select ${kind}, ${idempotencyKey}, ${sql.json(payload ?? {})}, ${scheduledAt}
        where not exists (
          select 1 from async_tasks
          where kind = ${kind} and status in ('pending', 'running')
        )
        on conflict (idempotency_key) do nothing
        returning id
      `;
      return rows.length ? rows[0].id : null;
    },

    /** 返回同 kind 当前活跃任务（pending/running），按入队序取最早；无则 null。 */
    async findActiveTask({ kind }) {
      const rows = await sql`
        select id, status from async_tasks
        where kind = ${kind} and status in ('pending', 'running')
        order by created_at
        limit 1
      `;
      return rows[0] ?? null;
    },

    /** 同一浏览器职位目标去重；不同职位可排队，调度器仍按 kind 串行执行。 */
    async enqueueBrowserJobTaskIfTargetIdle({ idempotencyKey, payload, scheduledAt }) {
      const rows = await sql`
        insert into async_tasks (kind, idempotency_key, payload, scheduled_at)
        select 'browser_job_collect', ${idempotencyKey}, ${sql.json(payload)}, ${scheduledAt}
        where not exists (
          select 1 from async_tasks
          where kind = 'browser_job_collect'
            and status in ('pending', 'running')
            and payload->>'sourceConnectionId' = ${payload.sourceConnectionId}
            and payload->>'userId' = ${payload.userId}
            and payload->>'deviceId' = ${payload.deviceId}
            and payload->>'contractId' = ${payload.contractId}
            and payload->>'externalId' = ${payload.externalId}
        )
        returning id
      `;
      return rows[0]?.id ?? null;
    },

    async findActiveBrowserJobTask(payload) {
      const rows = await sql`
        select id, status from async_tasks
        where kind = 'browser_job_collect'
          and status in ('pending', 'running')
          and payload->>'sourceConnectionId' = ${payload.sourceConnectionId}
          and payload->>'userId' = ${payload.userId}
          and payload->>'deviceId' = ${payload.deviceId}
          and payload->>'contractId' = ${payload.contractId}
          and payload->>'externalId' = ${payload.externalId}
        order by created_at
        limit 1
      `;
      return rows[0] ?? null;
    },

    /**
     * 任务看门狗：回收崩溃/超时残留的 `running` 任务（started_at 早于 staleBefore 的
     * 一律标记 failed + TASK_STALE_TIMEOUT）。进程中断后任务会永久卡 running，
     * 而手动同步去重把 running 视为活跃——没有本回收，去重守卫会被卡死任务永久锁死。
     * 返回回收数；与 sync_runs 看门狗（failStaleRunningSyncRuns）对称，仅调度 tick 调用。
     */
    async failStaleRunningTasks({ staleBefore, errorCode = "TASK_STALE_TIMEOUT" }) {
      const rows = await sql`
        update async_tasks
        set status = 'failed',
            last_error_code = ${errorCode},
            finished_at = now(),
            updated_at = now()
        where status = 'running'
          and started_at < ${staleBefore}
        returning id
      `;
      return rows.length;
    },

    /**
     * 认领到期 pending 任务（scheduled_at 到期且 next_attempt_at 放行），返回含 post-increment attempts。
     * 串行化（fix3）：同一 kind 同时只跑一个——
     *  - 排除该 kind 已有 running 任务（`not exists running`）；
     *  - 每个 kind 只认领最早的 pending（`not exists earlier` 行比较，取 (scheduled_at,id) 最小）。
     * 用 EXISTS 而非窗口函数/DISTINCT，因 `FOR UPDATE SKIP LOCKED` 无法锁定含窗口函数的子查询
     * （PG 0A000）；EXISTS 子查询可加锁且跨进程原子（SKIP LOCKED 保证同 kind 不双认领）。
     * 不同 kind 可各认领一个。
     */
    async claimDueTasks({ limit = 10, now }) {
      return sql`
        update async_tasks
        set status = 'running', attempts = attempts + 1,
            started_at = ${now}, updated_at = now()
        where id in (
          select a.id
          from async_tasks a
          where a.status = 'pending'
            and a.scheduled_at <= ${now}
            and (a.next_attempt_at is null or a.next_attempt_at <= ${now})
            and not exists (
              select 1 from async_tasks r
              where r.kind = a.kind and r.status = 'running'
            )
            and not exists (
              select 1 from async_tasks earlier
              where earlier.kind = a.kind
                and earlier.status = 'pending'
                and (earlier.scheduled_at, earlier.id) < (a.scheduled_at, a.id)
            )
          order by a.scheduled_at
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
