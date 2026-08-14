export async function listMatchExceptions(
  sql,
  { type = "all", page = 1, pageSize = 20 } = {},
) {
  const includeScoring = type === "all" || type === "scoring";
  const includeFilter = type === "all" || type === "filter";
  const rows = await sql`
    with exceptions as (
      select run.id, 'scoring'::text as type, run.error_code as "errorCode",
        'scoring_failed'::text as status,
        (run.attempt < 3 and run.error_code in ('LLM_TIMEOUT', 'LLM_RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_INTERNAL_ERROR')) as retryable,
        jp.job_id as "jobId", j.title as "jobTitle",
        cp.candidate_id as "candidateId", c.display_name as "candidateName",
        run.created_at as "createdAt"
      from llm_score_runs run
      join match_filter_results fr on fr.id = run.filter_result_id
      join job_match_projections jp on jp.id = fr.job_projection_id
      join candidate_match_projections cp on cp.id = fr.candidate_projection_id
      join jobs j on j.id = jp.job_id
      join candidates c on c.id = cp.candidate_id
      where ${includeScoring} and run.status = 'failed'
      union all
      select fr.id, 'filter'::text as type,
        coalesce(fr.reason_codes -> 0 ->> 'code', 'FILTER_REJECTED') as "errorCode",
        'filter_rejected'::text as status, false as retryable,
        jp.job_id as "jobId", j.title as "jobTitle",
        cp.candidate_id as "candidateId", c.display_name as "candidateName",
        fr.created_at as "createdAt"
      from match_filter_results fr
      join job_match_projections jp on jp.id = fr.job_projection_id
      join candidate_match_projections cp on cp.id = fr.candidate_projection_id
      join jobs j on j.id = jp.job_id
      join candidates c on c.id = cp.candidate_id
      where ${includeFilter} and fr.passed = false
        and exists (select 1 from jsonb_array_elements(fr.reason_codes) reason where reason ->> 'code' = 'REQUIRED_FIELD_MISSING')
    )
    select *, count(*) over()::int as "fullCount"
    from exceptions
    order by "createdAt" desc, id desc
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `;
  const total = rows[0]?.fullCount ?? 0;
  return {
    total, page, pageSize, totalPages: Math.ceil(total / pageSize),
    list: rows.map((item) => ({
      id: item.id,
      type: item.type,
      errorCode: item.errorCode,
      status: item.status,
      retryable: item.retryable,
      jobId: item.jobId,
      jobTitle: item.jobTitle,
      candidateId: item.candidateId,
      candidateName: item.candidateName,
      createdAt: item.createdAt,
    })),
  };
}
