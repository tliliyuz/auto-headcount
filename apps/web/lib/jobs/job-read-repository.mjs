/**
 * 职位只读仓储：服务业务页面的沉睡职位列表。
 *
 * 沉睡规则（01-mvp-requirements §1.1）的 SQL 投影：
 *   status = 'active' AND days_without_recommendation BETWEEN 7 AND 30
 *   AND (valid_recommendation_count IS NULL OR valid_recommendation_count = 0)
 * （7/30 天边界包含在内；同步任务把零推荐职位写入 valid_recommendation_count = NULL，
 * 未来推荐工作流写入真值 0 时同样纳入——NULL 与 0 同义。）
 * 此查询命中既有索引 jobs_under_served_idx(status, days_without_recommendation)。
 *
 * 字段投影为内部运营 API 白名单：company_name/detailed_location 仅内部可见；
 * 绝不投影 raw_records 的 payload_*（原始载荷加密存放，永不外发）。
 * ageDays/recommendationCount 别名与 lib/job-rules.mjs 消费形状对齐。
 */
export async function listUnderServedJobs(
  sql,
  { category, q, page = 1, pageSize = 20 } = {},
) {
  const categoryFilter = category && category !== "全部";
  const query = q?.trim();
  const needle = query ? `%${query}%` : null;
  const where = sql`
    status = 'active'
    and days_without_recommendation between 7 and 30
    and (valid_recommendation_count is null or valid_recommendation_count = 0)
    ${categoryFilter ? sql` and category = ${category}` : sql``}
    ${query ? sql` and (title ilike ${needle} or city ilike ${needle})` : sql``}
  `;

  const [{ total }] = await sql`
    select count(*)::int as total
    from jobs
    where ${where}
  `;

  const list = await sql`
    select
      id,
      external_id as "externalId",
      mapping_version as "mappingVersion",
      title,
      company_name as "companyName",
      category,
      city,
      detailed_location as "detailedLocation",
      salary_min as "salaryMin",
      salary_max as "salaryMax",
      status,
      days_without_recommendation as "ageDays",
      coalesce(valid_recommendation_count, 0) as "recommendationCount",
      source_connection_id as "sourceConnectionId",
      raw_record_id as "rawRecordId",
      published_at as "publishedAt",
      source_updated_at as "sourceUpdatedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from jobs
    where ${where}
    order by days_without_recommendation desc, created_at desc
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
