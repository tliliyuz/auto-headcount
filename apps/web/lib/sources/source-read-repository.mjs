/**
 * 数据源/同步批次只读仓储：服务「数据源」页。
 *
 * listSources 用 left join lateral 取每个连接的最新一次 sync_runs 摘要；
 * listSyncRuns join source_connections 提供来源展示名。
 * sync_runs.cursor 为供应方游标令牌，属敏感边界，永不投影；
 * stats 仅含计数，error_code 仅机器码，可安全返回。
 */
export async function listSources(sql, { page = 1, pageSize = 50 } = {}) {
  const [{ total }] = await sql`
    select count(*)::int as total from source_connections
  `;

  const list = await sql`
    select
      sc.id,
      sc.provider,
      sc.environment,
      sc.status,
      sc.display_name as "displayName",
      sc.created_at as "createdAt",
      sc.updated_at as "updatedAt",
      last_run.id as "lastRunId",
      last_run.sync_type as "lastRunSyncType",
      last_run.status as "lastRunStatus",
      last_run.started_at as "lastRunStartedAt",
      last_run.finished_at as "lastRunFinishedAt",
      last_run.error_code as "lastRunErrorCode",
      last_run.stats as "lastRunStats"
    from source_connections sc
    left join lateral (
      select sr.id, sr.sync_type, sr.status, sr.started_at,
             sr.finished_at, sr.error_code, sr.stats
      from sync_runs sr
      where sr.source_connection_id = sc.id
      order by sr.created_at desc, sr.id desc
      limit 1
    ) last_run on true
    order by sc.created_at desc
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

/**
 * 同步批次列表。`excludeBrowserDetail`（默认 true）排除逐职位/逐候选人详情采集的内部
 * sync_run（browser_job_collect/browser_candidate_collect）：这些是详情提取的落库审计，
 * 已由 browser_collection_batches/browser_candidate_batches 聚合展示，混入会淹没周期同步、
 * 且让「上次同步时间」失真。
 */
export async function listSyncRuns(
  sql,
  { status, page = 1, pageSize = 20, excludeBrowserDetail = true } = {},
) {
  const where = sql`
    1 = 1
    ${status ? sql` and sr.status = ${status}` : sql``}
    ${
      excludeBrowserDetail
        ? sql` and sr.sync_type not in ('browser_job_collect', 'browser_candidate_collect')`
        : sql``
    }
  `;

  const [{ total }] = await sql`
    select count(*)::int as total
    from sync_runs sr
    where ${where}
  `;

  const list = await sql`
    select
      sr.id,
      sr.source_connection_id as "sourceConnectionId",
      sc.display_name as "sourceDisplayName",
      sc.provider as "sourceProvider",
      sr.sync_type as "syncType",
      sr.status,
      sr.stats,
      sr.error_code as "errorCode",
      sr.started_at as "startedAt",
      sr.finished_at as "finishedAt",
      sr.created_at as "createdAt"
    from sync_runs sr
    join source_connections sc on sc.id = sr.source_connection_id
    where ${where}
    order by sr.created_at desc, sr.id desc
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
