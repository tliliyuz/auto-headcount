/**
 * `job_requirements` 写仓储：选择需要结构化提取的职位 + 幂等 upsert。
 * `job_requirements` 单行/职位（`job_id` unique，迁移 0007）。
 */

/** 选择「有 JD 且尚无 job_requirements」的可操作职位（fill-when-missing）。 */
export async function selectJobsNeedingRequirementsExtraction(sql, { limit = 100 } = {}) {
  return sql`
    select j.id, j.title, j.category, j.job_description
    from jobs j
    where j.status = 'active'
      and j.job_description is not null
      and not exists (
        select 1 from job_requirements r where r.job_id = j.id
      )
    order by j.created_at
    limit ${limit}
  `;
}

/**
 * 幂等 upsert 职位要求。`constraints` 是 jsonb 对象（消费端按对象读，
 * 见 projection-filter-sync.loadJob / match-sync.loadJobRequirements）。
 */
export async function upsertJobRequirements(sql, { jobId, requirements }) {
  return sql`
    insert into job_requirements (
      job_id, skills, seniority, education, salary_min, salary_max, constraints
    ) values (
      ${jobId},
      ${sql.json(requirements.skills ?? [])},
      ${requirements.seniority ?? null},
      ${requirements.education ?? null},
      ${requirements.salaryMin ?? null},
      ${requirements.salaryMax ?? null},
      ${sql.json(requirements.constraints ?? {})}
    )
    on conflict (job_id) do update set
      skills = excluded.skills,
      seniority = excluded.seniority,
      education = excluded.education,
      salary_min = excluded.salary_min,
      salary_max = excluded.salary_max,
      constraints = excluded.constraints,
      updated_at = now()
    returning id
  `;
}
