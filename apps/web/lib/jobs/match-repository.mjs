/**
 * 匹配写入仓储：候选人与匹配结果的幂等落库（docs/03 §8，迁移 0007）。
 *
 * - 候选人从 `match_candidates` 的 candidate_summary 投影（已打码、无联系方式——docs/06）。
 * - 匹配结果 `(job_id, candidate_id, rule_version)` 唯一幂等 upsert；
 *   `score_status=pending`（LLM 打分中）是正常态，落 pending 不视为失败。
 * - 已审核（approved/rejected）的匹配重跑不覆盖审核状态。
 * - 不投影/不落 portal_url 与任何联系方式。
 */

/** 候选人幂等 upsert（source_connection_id + external_id 唯一，docs/03 §7.3）；新摘要为 null 时不抹既有摘要。 */
export async function upsertCandidate(sql, { sourceConnectionId, externalId, displayName, summary }) {
  const rows = await sql`
    insert into candidates (source_connection_id, external_id, display_name, summary)
    values (${sourceConnectionId}, ${externalId}, ${displayName}, ${summary})
    on conflict (source_connection_id, external_id) do update set
      display_name = excluded.display_name,
      summary = coalesce(excluded.summary, candidates.summary),
      updated_at = now()
    returning id
  `;
  return rows[0].id;
}

/** 匹配结果幂等 upsert（本地评分权威分）；已审核（approved/rejected）状态不被重跑覆盖。 */
export async function upsertMatch(
  sql,
  {
    jobId,
    candidateId,
    score,
    band,
    status = "generated",
    ruleVersion,
    scoreStatus = "local_computed",
    inputHash = null,
    evidence = [],
    missing = [],
    risk = [],
    jobProjectionId = null,
    candidateProjectionId = null,
    filterResultId = null,
    llmScoreRunId = null,
    aggregationRuleVersion = null,
  },
) {
  const rows = await sql`
    insert into matches (
      job_id, candidate_id, score, band, status, rule_version,
      score_status, input_hash, evidence, missing, risk,
      job_projection_id, candidate_projection_id, filter_result_id,
      llm_score_run_id, aggregation_rule_version
    ) values (
      ${jobId}, ${candidateId},
      ${score === null || score === undefined ? null : Math.round(score)},
      ${band}, ${status}, ${ruleVersion}, ${scoreStatus}, ${inputHash},
      ${sql.json(evidence)}, ${sql.json(missing)}, ${sql.json(risk)},
      ${jobProjectionId}, ${candidateProjectionId}, ${filterResultId},
      ${llmScoreRunId}, ${aggregationRuleVersion}
    )
    on conflict (job_id, candidate_id, rule_version) do update set
      score = excluded.score,
      band = excluded.band,
      status = case
        when matches.status in ('generated', 'pending_review')
          then excluded.status
        else matches.status
      end,
      score_status = excluded.score_status,
      input_hash = excluded.input_hash,
      evidence = excluded.evidence,
      missing = excluded.missing,
      risk = excluded.risk,
      job_projection_id = excluded.job_projection_id,
      candidate_projection_id = excluded.candidate_projection_id,
      filter_result_id = excluded.filter_result_id,
      llm_score_run_id = excluded.llm_score_run_id,
      aggregation_rule_version = excluded.aggregation_rule_version,
      updated_at = now()
    returning id, status
  `;
  return rows[0];
}

/** 外部对照更新：把供应方 match_candidates 结果写入匹配的 external_*（非权威分，docs/04）。 */
export async function updateMatchExternalReference(
  sql,
  { jobId, externalCandidateId, externalScore, externalTier, externalScoreStatus, ruleVersion },
) {
  await sql`
    update matches m
    set external_score = ${externalScore},
        external_tier = ${externalTier},
        external_score_status = ${externalScoreStatus},
        updated_at = now()
    from candidates c
    where m.candidate_id = c.id
      and c.external_id = ${externalCandidateId}
      and m.job_id = ${jobId}
      and m.rule_version = ${ruleVersion}
  `;
}

/** 替换匹配维度分（重跑时整组替换）；来自本地评分各维度（含证据/风险）。 */
export async function replaceMatchDimensions(sql, { matchId, dimensions }) {
  await sql`delete from match_dimensions where match_id = ${matchId}`;
  for (const d of dimensions ?? []) {
    await sql`
      insert into match_dimensions (
        match_id, dimension, score, evidence, risk,
        assessable, confidence, llm_score_run_id, output_hash
      )
      values (
        ${matchId}, ${d.dimension},
        ${d.score === null || d.score === undefined ? null : Math.round(d.score)},
        ${d.evidence ?? null}, ${d.risk ?? null},
        ${d.assessable ?? null}, ${d.confidence ?? null},
        ${d.llmScoreRunId ?? null}, ${d.outputHash ?? null}
      )
    `;
  }
  return dimensions?.length ?? 0;
}

/**
 * 审核状态流转（docs/03 §9）：仅从 `generated`/`pending_review` 可流转到 `approved`/`rejected`。
 * 已审核的匹配返回 null（路由 409）；只有 approved 的匹配可进入触达（M3 门禁）。
 */
export async function updateMatchStatus(sql, { id, status }) {
  const rows = await sql`
    update matches
    set status = ${status}, updated_at = now()
    where id = ${id} and status in ('generated', 'pending_review')
    returning id
  `;
  return rows[0]?.id ?? null;
}
