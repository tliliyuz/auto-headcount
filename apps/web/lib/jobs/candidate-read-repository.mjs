/**
 * 候选人只读仓储：服务候选人池页的候选人画像列表。
 *
 * 候选人画像属敏感业务（docs/06 §敏感业务）：真实姓名（display_name）只在
 * RBAC operations/admin 会话下返回；绝不投影 raw_records 的 payload_*
 * （联系方式/简历正文信封加密存放，永不外发）。
 *
 * 匹配状态从 matches 推导：已审核（存在 approved/rejected）→ 已匹配（存在 generated）→ 待匹配。
 * 只列出有画像内容的候选人（current_title 或经验非空），排除落地页预览产生的空画像夹具。
 */
export async function listCandidates(
  sql,
  { q, status, page = 1, pageSize = 20 } = {},
) {
  const query = q?.trim();
  const needle = query ? `%${query}%` : null;
  const statusFilter = status && status !== "全部" ? status : null;

  const where = sql`
    1 = 1
    ${query ? sql` and (
      c.display_name ilike ${needle}
      or p.current_title ilike ${needle}
      or p.current_company ilike ${needle}
      or p.location ilike ${needle}
      or p.school ilike ${needle}
      or p.major ilike ${needle}
    )` : sql``}
    ${
      statusFilter
        ? sql`
            and case
              when exists (select 1 from matches ma where ma.candidate_id = c.id and ma.status in ('approved','rejected')) then '已审核'
              when exists (select 1 from matches ma where ma.candidate_id = c.id) then '已匹配'
              else '待匹配'
            end = ${statusFilter}`
        : sql``
    }
  `;

  const [{ total }] = await sql`
    select count(*)::int as total
    from candidates c
    join candidate_profiles p on p.candidate_id = c.id
    where (p.current_title is not null or p.experience_years is not null)
      and ${where}
  `;

  const list = await sql`
    select
      c.id,
      c.external_id as "externalId",
      c.display_name as "name",
      c.summary,
      c.consent_status as "consentStatus",
      coalesce(p.current_title, p.seniority) as "title",
      p.current_company as "company",
      p.location as "city",
      p.experience_years as "experienceYears",
      p.education,
      p.school,
      p.major,
      p.seniority,
      p.industry,
      p.activity_updated_at as "activityUpdatedAt",
      c.created_at as "createdAt",
      (select count(*)::int from matches m where m.candidate_id = c.id) as "matchCount",
      case
        when exists (select 1 from matches m where m.candidate_id = c.id and m.status in ('approved','rejected')) then '已审核'
        when exists (select 1 from matches m where m.candidate_id = c.id) then '已匹配'
        else '待匹配'
      end as status
    from candidates c
    join candidate_profiles p on p.candidate_id = c.id
    where (p.current_title is not null or p.experience_years is not null)
      and ${where}
    order by c.created_at desc, c.id desc
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
