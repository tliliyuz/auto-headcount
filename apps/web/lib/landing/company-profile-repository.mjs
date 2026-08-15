/** 公司落地页隐性信息档案仓储（ADR-006 落地页切片）：按公司名维护脱敏 teaser，建链自动带出。 */

/** 按公司名 upsert（name 唯一，更新 4 个隐性信息字段）。可选字段缺省落 null。 */
export async function upsertCompanyLandingProfile(
  sql,
  { companyName, industryPositioning, companyScale, benchmarks, officeLocation },
) {
  const [row] = await sql`
    insert into company_landing_profiles (
      company_name, industry_positioning, company_scale, benchmarks, office_location
    ) values (
      ${companyName}, ${industryPositioning ?? null}, ${companyScale ?? null}, ${benchmarks ?? null}, ${officeLocation ?? null}
    )
    on conflict (company_name) do update set
      industry_positioning = excluded.industry_positioning,
      company_scale = excluded.company_scale,
      benchmarks = excluded.benchmarks,
      office_location = excluded.office_location,
      updated_at = now()
    returning id, company_name as "companyName",
      industry_positioning as "industryPositioning",
      company_scale as "companyScale",
      benchmarks, office_location as "officeLocation",
      created_at as "createdAt", updated_at as "updatedAt"
  `;
  return row;
}

export async function findCompanyLandingProfileByCompanyName(sql, companyName) {
  const [row] = await sql`
    select id, company_name as "companyName",
      industry_positioning as "industryPositioning",
      company_scale as "companyScale",
      benchmarks, office_location as "officeLocation",
      created_at as "createdAt", updated_at as "updatedAt"
    from company_landing_profiles
    where company_name = ${companyName}
  `;
  return row ?? null;
}
