/** 落地页意向回复仓储（ADR-006）：同链接唯一幂等，联系方式信封加密，notify 状态尽力转发。 */

/**
 * 创建意向回复；`(landing_link_id)` 唯一冲突时不写入并返回既有记录（deduplicated:true），
 * 不产生冲突数据（docs/07 §3）。
 */
export async function createIntentResponse(
  sql,
  {
    landingLinkId,
    option,
    ciphertext,
    nonce,
    keyVersion,
    phoneHmac,
    emailHmac,
    consentSnapshot,
  },
) {
  const [row] = await sql`
    insert into intent_responses (
      landing_link_id, option, contact_ciphertext, contact_nonce, contact_key_version,
      contact_phone_hmac, contact_email_hmac, consent_snapshot
    ) values (
      ${landingLinkId}, ${option}, ${ciphertext}, ${nonce}, ${keyVersion},
      ${phoneHmac}, ${emailHmac}, ${JSON.stringify(consentSnapshot)}
    )
    on conflict (landing_link_id) do nothing
    returning id, landing_link_id as "landingLinkId", option,
      notify_status as "notifyStatus", notify_error_code as "notifyErrorCode",
      created_at as "createdAt"
  `;
  if (row) return { response: row, deduplicated: false };
  const [existing] = await sql`
    select id, landing_link_id as "landingLinkId", option,
      notify_status as "notifyStatus", notify_error_code as "notifyErrorCode",
      created_at as "createdAt"
    from intent_responses where landing_link_id = ${landingLinkId}
  `;
  return { response: existing, deduplicated: true };
}

export async function findIntentResponseByLinkId(sql, landingLinkId) {
  const [row] = await sql`
    select id, landing_link_id as "landingLinkId", option,
      notify_status as "notifyStatus", notify_error_code as "notifyErrorCode",
      created_at as "createdAt"
    from intent_responses where landing_link_id = ${landingLinkId}
  `;
  return row ?? null;
}

/** 记录通知投递结果（尽力转发：成功/失败均落库，失败可重试，不影响意向真源）。 */
export async function markIntentNotifyResult(sql, { id, status, errorCode }) {
  await sql`
    update intent_responses
    set notify_status = ${status}, notify_error_code = ${errorCode}
    where id = ${id}
  `;
}
