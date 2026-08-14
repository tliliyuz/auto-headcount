/**
 * 匹配只读仓储：审核页的匹配结果列表与详情。
 * 白名单投影：候选人为打码名 + 摘要（来自 match_candidates），**绝不投影 portal_url、
 * candidate_contacts（联系方式）与 raw_records.payload_***（docs/03 §7、docs/06）。
 * 评分来自供应方（docs/04 §6），本地只分带/审计投影/记录版本。
 */

/** 匹配列表（分页包络），可按 jobId/band/status 过滤。 */
export async function listMatches(
  sql,
  { jobId, band, status, page = 1, pageSize = 20 } = {},
) {
  const where = sql`
    1 = 1
    ${jobId ? sql` and m.job_id = ${jobId}` : sql``}
    ${band ? sql` and m.band = ${band}` : sql``}
    ${status ? sql` and m.status = ${status}` : sql``}
  `;

  const [{ total }] = await sql`
    select count(*)::int as total
    from matches m
    where ${where}
  `;

  const list = await sql`
    select
      m.id,
      m.job_id as "jobId",
      j.title as "jobTitle",
      j.external_id as "jobExternalId",
      m.candidate_id as "candidateId",
      c.display_name as "candidateName",
      c.summary as "candidateSummary",
      m.score,
      m.band,
      m.status,
      m.rule_version as "ruleVersion",
      m.input_hash as "inputHash",
      m.score_status as "scoreStatus",
      m.external_score as "externalScore",
      m.external_tier as "externalTier",
      m.external_score_status as "externalScoreStatus",
      m.evidence,
      m.missing,
      m.risk,
      m.job_projection_id as "jobProjectionId",
      m.candidate_projection_id as "candidateProjectionId",
      m.llm_score_run_id as "llmScoreRunId",
      m.aggregation_rule_version as "aggregationRuleVersion",
      case when fr.id is null then null else json_build_object('passed', fr.passed, 'reasonCodes', fr.reason_codes) end as "filterResult",
      run.model_id as "modelId", run.model_revision as "modelRevision",
      run.prompt_version as "promptVersion", run.schema_version as "schemaVersion",
      run.output_hash as "outputHash",
      m.created_at as "createdAt",
      m.updated_at as "updatedAt"
    from matches m
    join jobs j on j.id = m.job_id
    join candidates c on c.id = m.candidate_id
    left join match_filter_results fr on fr.id = m.filter_result_id
    left join llm_score_runs run on run.id = m.llm_score_run_id
    where ${where}
    order by m.created_at desc, m.id desc
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

/** 匹配详情：含维度分（match_dimensions）。查无返回 undefined → 路由 404。 */
export async function getMatchById(sql, id) {
  const [match] = await sql`
    select
      m.id,
      m.job_id as "jobId",
      j.title as "jobTitle",
      j.external_id as "jobExternalId",
      m.candidate_id as "candidateId",
      c.display_name as "candidateName",
      c.summary as "candidateSummary",
      m.score,
      m.band,
      m.status,
      m.rule_version as "ruleVersion",
      m.input_hash as "inputHash",
      m.score_status as "scoreStatus",
      m.external_score as "externalScore",
      m.external_tier as "externalTier",
      m.external_score_status as "externalScoreStatus",
      m.evidence,
      m.missing,
      m.risk,
      m.job_projection_id as "jobProjectionId",
      m.candidate_projection_id as "candidateProjectionId",
      m.llm_score_run_id as "llmScoreRunId",
      m.aggregation_rule_version as "aggregationRuleVersion",
      case when fr.id is null then null else json_build_object('passed', fr.passed, 'reasonCodes', fr.reason_codes) end as "filterResult",
      run.model_id as "modelId", run.model_revision as "modelRevision",
      run.prompt_version as "promptVersion", run.schema_version as "schemaVersion",
      run.output_hash as "outputHash",
      m.created_at as "createdAt",
      m.updated_at as "updatedAt"
    from matches m
    join jobs j on j.id = m.job_id
    join candidates c on c.id = m.candidate_id
    left join match_filter_results fr on fr.id = m.filter_result_id
    left join llm_score_runs run on run.id = m.llm_score_run_id
    where m.id = ${id}
  `;
  if (!match) return undefined;

  const dimensions = await sql`
    select dimension, score, evidence, risk, assessable, confidence,
      llm_score_run_id as "llmScoreRunId", output_hash as "outputHash"
    from match_dimensions
    where match_id = ${id}
    order by created_at, id
  `;
  return { ...match, dimensions };
}
