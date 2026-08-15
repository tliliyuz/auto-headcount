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
import { findApprovedMatchForJobCandidate } from "../jobs/match-repository.mjs";
import { findValidLandingLinkByTokenHash } from "./landing-link-repository.mjs";
import { toAiEvaluation, toMaskedJobView } from "./landing-mask.mjs";
import { hashLandingToken } from "./landing-token.mjs";

export const LANDING_INTENT_OPTIONS = ["A", "B", "C", "opt_out"];
export const LANDING_LINK_UNAVAILABLE_CODE = "landing_link_unavailable";

/**
 * 公开侧取落地页脱敏职位视图：令牌哈希门禁（存在 + 未过期 + 未撤销）。
 * 组装脱敏职位字段 + 候选人姓名（本人可见）+ 公司隐性信息 teaser（公司档案，可能为 null）
 * + AI 匹配评价（已审核匹配投影，可能为 null，docs/07 §3 P5）。
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
  const match = await findApprovedMatchForJobCandidate(sql, {
    jobId: link.jobId,
    candidateId: link.candidateId,
  });
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
    aiEvaluation: toAiEvaluation(match),
  };
}

/**
 * 提交意向（ADR-006）：令牌门禁 → 同链接幂等 → 联系方式信封加密落库 →
 * notifier 适配器尽力投递（有界超时，失败不影响意向真源）→ notify 状态落库。
 * 联系方式可选（2026-08-16 放开）：无联系方式时跳过加密、contact 列为空，仍尽力投递；
 * 选项 A 必须留联系方式的校验在公开路由层（docs/07 §3）。
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

  // 2026-08-16 放开：选项 A 必填联系方式，B/C/退订可选 → 无联系方式时不加密，contact 列为空。
  const hasContact = Boolean((phone ?? "").trim() || (email ?? "").trim());
  const encrypted = hasContact
    ? await encryptSubmittedContact(
        { phone, email },
        { key: config.encryptionKey, keyVersion: config.encryptionKeyVersion },
      )
    : null;
  const { response, deduplicated } = await createIntentResponse(sql, {
    landingLinkId: link.id,
    option,
    ciphertext: encrypted?.ciphertext ?? null,
    nonce: encrypted?.nonce ?? null,
    keyVersion: encrypted?.keyVersion ?? null,
    phoneHmac: encrypted?.phoneHmac ?? null,
    emailHmac: encrypted?.emailHmac ?? null,
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
