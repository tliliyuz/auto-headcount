/**
 * 匹配投影仓储（docs/03 §7.4，迁移 0008）。
 *
 * - 职位/候选人投影**不可变**：唯一约束含 `input_hash`（源规范化内容哈希）。
 *   同实体源内容变化 → 新哈希 → 新投影行；同内容重跑 → `ON CONFLICT DO NOTHING` 返回既有 id，
 *   不覆盖旧行（版本不覆盖，docs/10 §2）。
 * - 候选人 `redacted_detail` 应用层 AES-256-GCM 加密落库（docs/03 §7.4）；读侧不投影密文。
 * - 不投影/不落任何联系方式（docs/06）；residual_pii_scan 非 passed 的投影不落消费态。
 */

import { encryptJsonPayload } from "../security/payload-encryption.mjs";

/**
 * 落库职位要求投影（不可变）。`projection` 已通过 Schema 校验（docs/10 §2）。
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function insertJobProjection(
  sql,
  {
    jobId,
    schemaVersion,
    generatorType,
    generatorVersion,
    inputHash,
    sourceSnapshotRefs,
    displaySummary,
    requirements,
    status = "consumable",
  },
) {
  const rows = await sql`
    insert into job_match_projections (
      job_id, schema_version, generator_type, generator_version, input_hash,
      source_snapshot_refs, display_summary, requirements, status
    ) values (
      ${jobId}, ${schemaVersion}, ${generatorType}, ${generatorVersion}, ${inputHash},
      ${sql.json(sourceSnapshotRefs ?? [])}, ${displaySummary}, ${sql.json(requirements)}, ${status}
    )
    on conflict (job_id, schema_version, generator_version, input_hash)
    do nothing
    returning id
  `;
  if (rows.length === 1) {
    return { id: rows[0].id, created: true };
  }
  // 命中唯一约束 → 返回既有投影 id（不覆盖）
  const [existing] = await sql`
    select id from job_match_projections
    where job_id = ${jobId}
      and schema_version = ${schemaVersion}
      and generator_version = ${generatorVersion}
      and input_hash = ${inputHash}
  `;
  return { id: existing.id, created: false };
}

/**
 * 落库候选人脱敏匹配投影（不可变；redacted_detail 加密）。
 * @param {object} encryption - { key, keyVersion }
 * @returns {Promise<{id: string, created: boolean}>}
 */
export async function insertCandidateProjection(
  sql,
  {
    candidateId,
    schemaVersion,
    generatorVersion,
    redactionVersion,
    inputHash,
    sourceSnapshotRefs,
    displaySummary,
    profile,
    redactedDetail,
    redactionReport,
    status = "consumable",
  },
  encryption,
) {
  const encrypted = await encryptJsonPayload(redactedDetail ?? {}, encryption);
  const rows = await sql`
    insert into candidate_match_projections (
      candidate_id, schema_version, generator_version, redaction_version, input_hash,
      source_snapshot_refs, display_summary, profile,
      redacted_detail_ciphertext, redacted_detail_nonce, key_version, redacted_detail_hash,
      redaction_report, status
    ) values (
      ${candidateId}, ${schemaVersion}, ${generatorVersion}, ${redactionVersion}, ${inputHash},
      ${sql.json(sourceSnapshotRefs ?? [])}, ${displaySummary}, ${sql.json(profile)},
      ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.keyVersion}, ${encrypted.payloadHash},
      ${sql.json(redactionReport)}, ${status}
    )
    on conflict (candidate_id, schema_version, generator_version, redaction_version, input_hash)
    do nothing
    returning id
  `;
  if (rows.length === 1) {
    return { id: rows[0].id, created: true };
  }
  const [existing] = await sql`
    select id from candidate_match_projections
    where candidate_id = ${candidateId}
      and schema_version = ${schemaVersion}
      and generator_version = ${generatorVersion}
      and redaction_version = ${redactionVersion}
      and input_hash = ${inputHash}
  `;
  return { id: existing.id, created: false };
}

/** 按唯一约束定位既有职位投影 id（管线复用）。 */
export async function findJobProjection(
  sql,
  { jobId, schemaVersion, generatorVersion, inputHash },
) {
  const rows = await sql`
    select id from job_match_projections
    where job_id = ${jobId}
      and schema_version = ${schemaVersion}
      and generator_version = ${generatorVersion}
      and input_hash = ${inputHash}
  `;
  return rows[0]?.id ?? null;
}

/** 按唯一约束定位既有候选人投影 id（管线复用）。 */
export async function findCandidateProjection(
  sql,
  { candidateId, schemaVersion, generatorVersion, redactionVersion, inputHash },
) {
  const rows = await sql`
    select id from candidate_match_projections
    where candidate_id = ${candidateId}
      and schema_version = ${schemaVersion}
      and generator_version = ${generatorVersion}
      and redaction_version = ${redactionVersion}
      and input_hash = ${inputHash}
  `;
  return rows[0]?.id ?? null;
}
