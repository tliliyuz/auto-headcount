/** 落地页链接仓储（ADR-006）：只存令牌哈希，令牌门禁 = 存在 + 未过期 + 未撤销。 */

export async function createLandingLink(
  sql,
  { jobId, candidateId, tokenHash, expiresAt, createdBy },
) {
  const [row] = await sql`
    insert into landing_links (job_id, candidate_id, token_hash, expires_at, created_by)
    values (${jobId}, ${candidateId}, ${tokenHash}, ${expiresAt}, ${createdBy})
    returning id, job_id as "jobId", candidate_id as "candidateId",
      token_hash as "tokenHash", expires_at as "expiresAt",
      revoked_at as "revokedAt", revoked_by as "revokedBy",
      created_by as "createdBy", created_at as "createdAt"
  `;
  return row;
}

/** 按令牌哈希查「有效」链接：存在 + 未撤销 + 未过期，并联出脱敏职位字段 + 候选人姓名 + 公司名（隐性信息档案键）。查无/失效返回 null。 */
export async function findValidLandingLinkByTokenHash(sql, { tokenHash, now }) {
  const [row] = await sql`
    select l.id, l.job_id as "jobId", l.candidate_id as "candidateId",
           l.expires_at as "expiresAt", l.revoked_at as "revokedAt",
           j.title, j.category, j.city,
           j.salary_min as "salaryMin", j.salary_max as "salaryMax",
           j.job_description as "jobDescription",
           j.company_name as "companyName",
           c.display_name as "candidateName"
    from landing_links l
    join jobs j on j.id = l.job_id
    join candidates c on c.id = l.candidate_id
    where l.token_hash = ${tokenHash}
      and l.revoked_at is null
      and l.expires_at > ${now}
  `;
  return row ?? null;
}

export async function findLandingLinkById(sql, id) {
  const [row] = await sql`
    select id, job_id as "jobId", candidate_id as "candidateId",
      token_hash as "tokenHash", expires_at as "expiresAt",
      revoked_at as "revokedAt", revoked_by as "revokedBy",
      created_by as "createdBy", created_at as "createdAt"
    from landing_links
    where id = ${id}
  `;
  return row ?? null;
}

export async function revokeLandingLink(sql, { id, revokedBy, now }) {
  const [row] = await sql`
    update landing_links
    set revoked_at = ${now}, revoked_by = ${revokedBy}
    where id = ${id} and revoked_at is null
    returning id, job_id as "jobId", candidate_id as "candidateId",
      token_hash as "tokenHash", expires_at as "expiresAt",
      revoked_at as "revokedAt", revoked_by as "revokedBy",
      created_by as "createdBy", created_at as "createdAt"
  `;
  return row ?? null;
}

export async function listLandingLinks(sql, { page = 1, pageSize = 10 } = {}) {
  const offset = (page - 1) * pageSize;
  const [{ count }] = await sql`select count(*)::int as count from landing_links`;
  const list = await sql`
    select l.id, l.job_id as "jobId", l.candidate_id as "candidateId",
      l.token_hash as "tokenHash", l.expires_at as "expiresAt",
      l.revoked_at as "revokedAt", l.revoked_by as "revokedBy",
      l.created_by as "createdBy", l.created_at as "createdAt",
      j.title as "jobTitle"
    from landing_links l
    join jobs j on j.id = l.job_id
    order by l.created_at desc
    limit ${pageSize} offset ${offset}
  `;
  return {
    total: count,
    page,
    pageSize,
    totalPages: Math.ceil(count / pageSize),
    list,
  };
}
