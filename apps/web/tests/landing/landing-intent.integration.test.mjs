import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import {
  decryptSubmittedContact,
  hmacValue,
  normalizeEmail,
  normalizePhone,
} from "../../lib/landing/landing-contact.mjs";
import {
  findCompanyLandingProfileByCompanyName,
  upsertCompanyLandingProfile,
} from "../../lib/landing/company-profile-repository.mjs";
import { createLandingLink } from "../../lib/landing/landing-link-repository.mjs";
import {
  getLandingJobView,
  LANDING_LINK_UNAVAILABLE_CODE,
  submitLandingIntent,
} from "../../lib/landing/landing-intent-service.mjs";
import { hashLandingToken } from "../../lib/landing/landing-token.mjs";

const connectionString = process.env.DATABASE_URL;
const ENC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const ENC_KEY_VERSION = "v1";
const CONSENT = { scope: "本次职位沟通", canRefuse: true, language: "zh-CN" };

test("落地页意向：令牌门禁、幂等、联系方式信封加密、通知尽力投递", !connectionString, async (t) => {
  const sql = postgres(connectionString);
  const now = new Date();
  t.after(async () => {
    await sql`delete from intent_responses`;
    await sql`delete from landing_links`;
    await sql`delete from matches`;
    await sql`delete from candidates`;
    await sql`delete from company_landing_profiles`;
    await sql`delete from jobs`;
    await sql`delete from source_connections`;
    await sql.end();
  });

  const [source] = await sql`
    insert into source_connections (provider, environment, display_name, status)
    values ('landing-intent-test', 'test', 'Landing Intent Test', 'active')
    returning id
  `;
  const [job] = await sql`
    insert into jobs (
      source_connection_id, external_id, mapping_version, title, company_name, category,
      city, salary_min, salary_max, status, days_without_recommendation,
      eligibility_evidence, portal_url, job_description
    ) values (
      ${source.id}, 'landing-intent-job', 'v1', '高级前端工程师', 'Fixture Co',
      'Engineering', '上海', 20, 30, 'active', 14,
      '{"source":"fixture"}', 'https://portal.invalid/landing-intent',
      '负责核心业务系统的前端架构。'
    )
    returning id
  `;
  const [candidate] = await sql`
    insert into candidates (source_connection_id, external_id, display_name)
    values (${source.id}, 'landing-intent-cand', '候选 A')
    returning id
  `;

  // 匹配：先落 pending_review（未审核，落地页不展示 AI 匹配评价）
  const [match] = await sql`
    insert into matches (job_id, candidate_id, score, band, status, rule_version, score_status)
    values (${job.id}, ${candidate.id}, 86, 'high', 'pending_review', 1, 'local_computed')
    returning id
  `;

  const token = "valid-token-for-intent-test";
  await createLandingLink(sql, {
    jobId: job.id,
    candidateId: candidate.id,
    tokenHash: hashLandingToken(token),
    expiresAt: new Date(now.getTime() + 86400000),
    createdBy: null,
  });

  const config = {
    encryptionKey: ENC_KEY,
    encryptionKeyVersion: ENC_KEY_VERSION,
    channel: "fake",
  };
  const phone = "138-0013-8000";
  const email = "CandidateA@Example.COM";

  // ① 首次提交：落库 + 通知成功
  const first = await submitLandingIntent(sql, {
    token,
    option: "A",
    phone,
    email,
    consentSnapshot: CONSENT,
    config,
    now,
  });
  assert.equal(first.ok, true);
  assert.equal(first.deduplicated, false);
  assert.equal(first.notifyStatus, "succeeded");
  assert.ok(first.responseId);

  // ② 库中联系方式信封加密，无明文；HMAC 可复核
  const [row] = await sql`
    select contact_ciphertext, contact_nonce, contact_key_version,
      contact_phone_hmac, contact_email_hmac, option
    from intent_responses where id = ${first.responseId}
  `;
  assert.ok(row.contact_ciphertext instanceof Uint8Array);
  assert.equal(row.contact_key_version, ENC_KEY_VERSION);
  assert.equal(row.contact_phone_hmac, hmacValue(normalizePhone(phone), ENC_KEY));
  assert.equal(row.contact_email_hmac, hmacValue(normalizeEmail(email), ENC_KEY));
  const decrypted = await decryptSubmittedContact(
    { ciphertext: row.contact_ciphertext, nonce: row.contact_nonce, keyVersion: row.contact_key_version },
    { key: ENC_KEY },
  );
  assert.equal(decrypted.phone, phone);
  // 信封存原始提交值；归一化只用于 HMAC 去重/抑制（normalizeEmail 断言见上方 hmac 校验）
  assert.equal(decrypted.email, email);

  // ③ 重复提交同一令牌 → 幂等去重，返回既有记录
  const second = await submitLandingIntent(sql, {
    token,
    option: "B",
    phone: "199-0000-0000",
    consentSnapshot: CONSENT,
    config,
    now,
  });
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.responseId, first.responseId);
  const [only] = await sql`select count(*)::int as c from intent_responses where landing_link_id = (select id from landing_links where token_hash = ${hashLandingToken(token)})`;
  assert.equal(only.c, 1, "同链接只应有一条意向回复");

  // ④ 无效令牌 → landing_link_unavailable
  const bad = await submitLandingIntent(sql, {
    token: "unknown-token",
    option: "A",
    phone,
    consentSnapshot: CONSENT,
    config,
    now,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, LANDING_LINK_UNAVAILABLE_CODE);

  // ⑤ 公司隐性信息档案 + 脱敏视图：候选人名 + teaser + 摘要
  const profile = await upsertCompanyLandingProfile(sql, {
    companyName: "Fixture Co",
    industryPositioning: "头部互联网大厂",
    companyScale: "万人规模上市公司",
    benchmarks: "直接竞品是 XX 与 YY",
    officeLocation: "就在北京望京核心区",
  });
  assert.equal(profile.companyName, "Fixture Co");
  const foundProfile = await findCompanyLandingProfileByCompanyName(sql, "Fixture Co");
  assert.equal(foundProfile.industryPositioning, "头部互联网大厂");

  const view = await getLandingJobView(sql, { token, now });
  assert.ok(view);
  assert.equal(view.candidateName, "候选 A", "候选人本人姓名可见");
  assert.equal(view.companyTeaser.industryPositioning, "头部互联网大厂");
  assert.equal(view.companyTeaser.officeLocation, "就在北京望京核心区");
  assert.ok(view.summary, "白名单职责摘要");
  // 更新档案后重新取视图应反映新值
  await upsertCompanyLandingProfile(sql, { companyName: "Fixture Co", companyScale: "D 轮创业公司" });
  const view2 = await getLandingJobView(sql, { token, now });
  assert.equal(view2.companyTeaser.companyScale, "D 轮创业公司");

  // 未审核匹配 → 不展示 AI 匹配评价
  assert.equal(view.aiEvaluation, null, "pending_review 不向候选人展示 AI 匹配评价");

  // 审核通过 + 维度分 → AI 匹配评价只投影白名单标签与数字分，绝不泄漏 evidence 原文
  await sql`update matches set status = 'approved' where id = ${match.id}`;
  await sql`
    insert into match_dimensions (match_id, dimension, score, evidence, assessable, confidence)
    values
      (${match.id}, 'skills', 90, '命中必备技能', true, 0.8),
      (${match.id}, 'location', 100, '城市一致', true, 0.9),
      (${match.id}, 'salary', 55, '薪资区间无重叠', true, 0.7)
  `;
  const view3 = await getLandingJobView(sql, { token, now });
  assert.ok(view3.aiEvaluation, "approved 匹配向候选人展示 AI 匹配评价");
  assert.equal(view3.aiEvaluation.score, 86);
  assert.equal(view3.aiEvaluation.bandLabel, "高度匹配");
  assert.deepEqual(
    view3.aiEvaluation.dimensions.map((d) => d.label),
    ["技能匹配", "城市匹配", "薪资预期"],
    "维度按规范序展示且只含白名单标签",
  );
  assert.equal(view3.aiEvaluation.dimensions[0].score, 90);
  assert.ok(
    !JSON.stringify(view3).includes("命中必备技能"),
    "AI 匹配评价不泄漏 LLM evidence 原文",
  );
  assert.ok(
    !JSON.stringify(view3).includes("薪资区间无重叠"),
    "AI 匹配评价不泄漏风险/证据 prose",
  );

  // ⑥ 未配置 webhook → 通知诚实失败（NOTIFIER_NOT_CONFIGURED），意向仍落库
  const token2 = "valid-token-for-no-webhook";
  await createLandingLink(sql, {
    jobId: job.id,
    candidateId: candidate.id,
    tokenHash: hashLandingToken(token2),
    expiresAt: new Date(now.getTime() + 86400000),
    createdBy: null,
  });
  const noWebhook = await submitLandingIntent(sql, {
    token: token2,
    option: "opt_out",
    phone: "137-1234-5678",
    consentSnapshot: CONSENT,
    config: { encryptionKey: ENC_KEY, encryptionKeyVersion: ENC_KEY_VERSION },
    now,
  });
  assert.equal(noWebhook.ok, true);
  assert.equal(noWebhook.deduplicated, false);
  assert.equal(noWebhook.notifyStatus, "failed");
  assert.equal(noWebhook.notifyErrorCode, "NOTIFIER_NOT_CONFIGURED");
  const [persisted] = await sql`
    select notify_status, notify_error_code from intent_responses where id = ${noWebhook.responseId}
  `;
  assert.equal(persisted.notify_status, "failed");
  assert.equal(persisted.notify_error_code, "NOTIFIER_NOT_CONFIGURED");
});
