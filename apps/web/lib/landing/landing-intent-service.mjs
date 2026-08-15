import { createNotifier } from "../notifier/notifier.mjs";
import {
  findCompanyLandingProfileByCompanyName,
} from "./company-profile-repository.mjs";
import { encryptSubmittedContact } from "./landing-contact.mjs";
import {
  createIntentResponse,
  findIntentResponseByLinkId,
  markIntentNotifyResult,
} from "./intent-repository.mjs";
import { findValidLandingLinkByTokenHash } from "./landing-link-repository.mjs";
import { toMaskedJobView } from "./landing-mask.mjs";
import { hashLandingToken } from "./landing-token.mjs";

export const LANDING_INTENT_OPTIONS = ["A", "B", "C", "opt_out"];
export const LANDING_LINK_UNAVAILABLE_CODE = "landing_link_unavailable";

/**
 * 公开侧取落地页脱敏职位视图：令牌哈希门禁（存在 + 未过期 + 未撤销）。
 * 组装脱敏职位字段 + 候选人姓名（本人可见）+ 公司隐性信息 teaser（公司档案，可能为 null）。
 * 失效令牌返回 null（对外统一「链接不可用」，防令牌枚举）。
 */
export async function getLandingJobView(sql, { token, now }) {
  const link = await findValidLandingLinkByTokenHash(sql, {
    tokenHash: hashLandingToken(token),
    now,
  });
  if (!link) return null;

  const profile = link.companyName
    ? await findCompanyLandingProfileByCompanyName(sql, link.companyName)
    : null;
  return {
    ...toMaskedJobView(link),
    candidateName: link.candidateName ?? null,
    companyTeaser: profile
      ? {
          industryPositioning: profile.industryPositioning,
          companyScale: profile.companyScale,
          benchmarks: profile.benchmarks,
          officeLocation: profile.officeLocation,
        }
      : null,
  };
}

/**
 * 提交意向（ADR-006）：令牌门禁 → 同链接幂等 → 联系方式信封加密落库 →
 * notifier 适配器尽力投递（有界超时，失败不影响意向真源）→ notify 状态落库。
 * 返回统一结果；`landing_link_unavailable` 表示令牌不存在/过期/撤销。
 */
export async function submitLandingIntent(
  sql,
  { token, option, phone, email, consentSnapshot, config, now },
) {
  const link = await findValidLandingLinkByTokenHash(sql, {
    tokenHash: hashLandingToken(token),
    now,
  });
  if (!link) {
    return { ok: false, code: LANDING_LINK_UNAVAILABLE_CODE };
  }

  const existing = await findIntentResponseByLinkId(sql, link.id);
  if (existing) {
    return {
      ok: true,
      deduplicated: true,
      responseId: existing.id,
      option: existing.option,
      notifyStatus: existing.notifyStatus,
    };
  }

  const encrypted = await encryptSubmittedContact(
    { phone, email },
    { key: config.encryptionKey, keyVersion: config.encryptionKeyVersion },
  );
  const { response, deduplicated } = await createIntentResponse(sql, {
    landingLinkId: link.id,
    option,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyVersion: encrypted.keyVersion,
    phoneHmac: encrypted.phoneHmac,
    emailHmac: encrypted.emailHmac,
    consentSnapshot,
  });

  if (deduplicated) {
    return {
      ok: true,
      deduplicated: true,
      responseId: response.id,
      option: response.option,
      notifyStatus: response.notifyStatus,
    };
  }
  const responseId = response.id;

  // 尽力投递：失败不影响意向真源；通知成功/失败均落 notify 状态供重试与审计。
  let notifyStatus = "succeeded";
  let notifyErrorCode = null;
  try {
    const notifier = createNotifier(config);
    const result = await notifier.sendNotification({
      contact: { phone, email },
      option,
      jobTitle: link.title,
      submittedAt: now.toISOString(),
    });
    if (!result.ok) {
      notifyStatus = "failed";
      notifyErrorCode = result.errorCode;
    }
  } catch {
    notifyStatus = "failed";
    notifyErrorCode = "NOTIFY_UNEXPECTED";
  }
  await markIntentNotifyResult(sql, { id: responseId, status: notifyStatus, errorCode: notifyErrorCode });

  return {
    ok: true,
    deduplicated: false,
    responseId,
    option,
    notifyStatus,
    notifyErrorCode,
  };
}
