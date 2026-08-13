/**
 * 硬过滤结果仓储（docs/03 §7.4，迁移 0008）。
 *
 * 第一阶段确定性硬过滤结果**不可变**：同一 (job_projection_id, candidate_projection_id,
 * filter_rule_version) 幂等——重跑同结果不重复落库（ON CONFLICT DO NOTHING 返回既有 id）。
 * `passed=false` 时不创建 LLM 评分运行（docs/10 §5）。
 */

/**
 * 落库硬过滤结果（不可变、幂等）。
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function insertMatchFilterResult(
  sql,
  {
    jobProjectionId,
    candidateProjectionId,
    filterRuleVersion,
    combinedInputHash,
    passed,
    reasonCodes,
  },
) {
  const rows = await sql`
    insert into match_filter_results (
      job_projection_id, candidate_projection_id, filter_rule_version,
      combined_input_hash, passed, reason_codes
    ) values (
      ${jobProjectionId}, ${candidateProjectionId}, ${filterRuleVersion},
      ${combinedInputHash}, ${passed}, ${sql.json(reasonCodes ?? [])}
    )
    on conflict (job_projection_id, candidate_projection_id, filter_rule_version)
    do nothing
    returning id
  `;
  if (rows.length === 1) {
    return { id: rows[0].id, created: true };
  }
  const [existing] = await sql`
    select id from match_filter_results
    where job_projection_id = ${jobProjectionId}
      and candidate_projection_id = ${candidateProjectionId}
      and filter_rule_version = ${filterRuleVersion}
  `;
  return { id: existing.id, created: false };
}
