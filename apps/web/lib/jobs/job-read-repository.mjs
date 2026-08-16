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
  const baseWhere = sql`
    status = 'active'
    and days_without_recommendation between 7 and 30
    and (valid_recommendation_count is null or valid_recommendation_count = 0)
    -- fix4：只展示可操作（账号自身作用域 wb.jobs.list 的交集）；null 视为可操作兼容迁移过渡
    and (operability_status is null or operability_status = 'actionable')
    ${categoryFilter ? sql` and category = ${category}` : sql``}
  `;
  // 同 JD 模板多城市批量挂岗去重：按 sha256(btrim(job_description)) 分组（空 JD 判 null 不分组），
  // 组内最小 job_id 为代表、cities = 城市并集。哈希表达式与匹配阶段二 loadPendingCandidates 一致。
  const grouped = sql`
    with eligible as (
      select j.id, j.external_id as "externalId", j.mapping_version as "mappingVersion",
        j.title, j.company_name as "companyName", j.category, j.city,
        j.detailed_location as "detailedLocation", j.salary_min as "salaryMin",
        j.salary_max as "salaryMax", j.status,
        j.days_without_recommendation as "ageDays",
        coalesce(j.valid_recommendation_count, 0) as "recommendationCount",
        j.source_connection_id as "sourceConnectionId", j.raw_record_id as "rawRecordId",
        j.published_at as "publishedAt", j.source_updated_at as "sourceUpdatedAt",
        j.created_at as "createdAt", j.updated_at as "updatedAt",
        (j.job_description is not null) as "hasDescription",
        case
          when j.job_description is null or btrim(j.job_description) = '' then null
          else encode(sha256(convert_to(btrim(j.job_description), 'UTF8')), 'hex')
        end as "jdHash"
      from jobs j
      where ${baseWhere}
    ),
    representative as (
      select e.*,
        row_number() over (
          partition by coalesce("jdHash", 'job:' || id)
          order by id
        ) as "rn"
      from eligible e
    ),
    grouped as (
      select r.*,
        (
          select coalesce(
            array_agg(distinct g.city order by g.city) filter (where g.city <> ''),
            '{}'::text[]
          )
          from eligible g
          where g."jdHash" = r."jdHash"
        ) as "cities"
      from representative r
      where r."rn" = 1
    )
  `;
  // q 检索：标题命中代表；城市命中组内任意城市并集（城市检索不再只看单条行）。
  // 空 JD 组（jdHash null）只匹配自身，避免「任意空 JD 职位命中某城市即全组通过」。
  const qFilter = query
    ? sql`title ilike ${needle} or exists (
        select 1 from eligible g
        where g.city ilike ${needle}
          and (
            (grouped."jdHash" is not null and g."jdHash" = grouped."jdHash")
            or (grouped."jdHash" is null and g.id = grouped.id)
          )
      )`
    : sql`true`;
  const project = sql`
    select id, "externalId", "mappingVersion", title, "companyName", category, city,
      "detailedLocation", "salaryMin", "salaryMax", status, "ageDays", "recommendationCount",
      "sourceConnectionId", "rawRecordId", "publishedAt", "sourceUpdatedAt", "createdAt", "updatedAt",
      "hasDescription", "cities"
    from grouped
    where ${qFilter}
  `;

  const [{ total }] = await sql`${grouped}
    select count(*)::int as total from grouped where ${qFilter}
  `;

  const list = await sql`${grouped}
    ${project}
    order by "ageDays" desc, "createdAt" desc, id desc
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
 * 职位详情（内部运营）：按 id 返回单条，含 `jobDescription`（完整 JD，可空）。
 * 投影与列表一致（companyName/detailedLocation 内部可见），**不含 `portal_url`**
 * （docs/04 §6：业务只读投影不返回 `portal_*`）与 `raw_records.payload_*`。
 * 查无返回 `undefined`（路由映射 404）。
 */
export async function getJobById(sql, id) {
  const [job] = await sql`
    select
      j.id,
      j.external_id as "externalId",
      j.mapping_version as "mappingVersion",
      j.title,
      j.company_name as "companyName",
      j.category,
      j.city,
      j.detailed_location as "detailedLocation",
      j.salary_min as "salaryMin",
      j.salary_max as "salaryMax",
      j.status,
      j.days_without_recommendation as "ageDays",
      coalesce(j.valid_recommendation_count, 0) as "recommendationCount",
      j.source_connection_id as "sourceConnectionId",
      j.raw_record_id as "rawRecordId",
      j.published_at as "publishedAt",
      j.source_updated_at as "sourceUpdatedAt",
      j.created_at as "createdAt",
      j.updated_at as "updatedAt",
      j.job_description as "jobDescription",
      (
        select coalesce(
          array_agg(distinct g.city order by g.city) filter (where g.city <> ''),
          '{}'::text[]
        )
        from jobs g
        where case
                when g.job_description is null or btrim(g.job_description) = '' then null
                else encode(sha256(convert_to(btrim(g.job_description), 'UTF8')), 'hex')
              end
            = case
                when j.job_description is null or btrim(j.job_description) = '' then null
                else encode(sha256(convert_to(btrim(j.job_description), 'UTF8')), 'hex')
              end
      ) as "cities"
    from jobs j
    where j.id = ${id}
  `;
  return job ?? undefined;
}
