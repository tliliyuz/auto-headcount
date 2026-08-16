import { decryptJsonPayload } from "../security/payload-encryption.mjs";

/**
 * 候选人只读仓储：服务候选人池页的候选人画像列表与详情。
 *
 * 候选人画像属敏感业务（docs/06 §敏感业务）：真实姓名（display_name）只在
 * RBAC operations/admin 会话下返回；绝不投影 raw_records 的 payload_*
 * （联系方式/简历正文信封加密存放，永不外发）。
 *
 * 匹配状态从 matches 推导：已审核（存在 approved/rejected）→ 已匹配（存在 generated）→ 待匹配。
 * 只列出有画像内容的候选人（current_title 或经验非空），排除落地页预览产生的空画像夹具。
 *
 * 工作经历存于 raw_records 加密载荷（详情合同逐条提取，未单独建表）；详情接口按需解密返回。
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

/**
 * 候选人详情：画像白名单字段 + 从 raw_records 加密载荷解密的工作经历。
 * `encryption`（APP_ENCRYPTION_KEY/VERSION）用于解密；仅内部运营 RBAC 会话调用。
 */
export async function getCandidateById(sql, id, { encryption }) {
  const rows = await sql`
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
      p.skills,
      p.activity_updated_at as "activityUpdatedAt",
      c.created_at as "createdAt",
      r.payload_ciphertext as "payloadCiphertext",
      r.payload_nonce as "payloadNonce",
      r.key_version as "keyVersion",
      (select count(*)::int from matches m where m.candidate_id = c.id) as "matchCount",
      case
        when exists (select 1 from matches m where m.candidate_id = c.id and m.status in ('approved','rejected')) then '已审核'
        when exists (select 1 from matches m where m.candidate_id = c.id) then '已匹配'
        else '待匹配'
      end as status
    from candidates c
    join candidate_profiles p on p.candidate_id = c.id
    left join raw_records r on r.id = c.raw_record_id
    where c.id = ${id}
  `;
  if (rows.length === 0) return undefined;
  const row = rows[0];

  let workExperiences = [];
  let projects = [];
  let educationHistory = [];
  if (row.payloadCiphertext && encryption?.key) {
    try {
      const plain = await decryptJsonPayload(
        {
          ciphertext: row.payloadCiphertext,
          nonce: row.payloadNonce,
          keyVersion: row.keyVersion,
        },
        { key: encryption.key },
      );
      workExperiences = Array.isArray(plain?.workExperiences)
        ? plain.workExperiences.map((entry) => ({
            company: entry?.company ?? null,
            title: entry?.title ?? null,
            city: entry?.city ?? null,
            period: entry?.period ?? null,
            duration: entry?.duration ?? null,
            description: entry?.description ?? null,
          }))
        : [];
      projects = Array.isArray(plain?.projects)
        ? plain.projects.map((entry) => ({
            name: entry?.name ?? null,
            description: entry?.description ?? null,
          }))
        : [];
      educationHistory = Array.isArray(plain?.education)
        ? plain.education.map((entry) => ({
            school: entry?.school ?? null,
            major: entry?.major ?? null,
            degree: entry?.degree ?? null,
            period: entry?.period ?? null,
            duration: entry?.duration ?? null,
          }))
        : [];
    } catch {
      // 解密失败（密钥轮换/数据异常）静默回落空简历段，不阻塞画像展示
    }
  }

  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    summary: row.summary,
    consentStatus: row.consentStatus,
    title: row.title,
    company: row.company,
    city: row.city,
    experienceYears: row.experienceYears,
    education: row.education,
    school: row.school,
    major: row.major,
    seniority: row.seniority,
    industry: row.industry,
    skills: row.skills ?? [],
    activityUpdatedAt: row.activityUpdatedAt,
    createdAt: row.createdAt,
    matchCount: row.matchCount,
    status: row.status,
    workExperiences,
    projects,
    educationHistory,
  };
}
