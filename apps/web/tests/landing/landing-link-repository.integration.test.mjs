import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import {
  createLandingLink,
  findValidLandingLinkByTokenHash,
  listLandingLinks,
  revokeLandingLink,
} from "../../lib/landing/landing-link-repository.mjs";
import {
  generateLandingToken,
  hashLandingToken,
} from "../../lib/landing/landing-token.mjs";

const connectionString = process.env.DATABASE_URL;

test("落地页链接：建链只存令牌哈希、门禁=存在且未过期未撤销、可撤销、分页", !connectionString, async (t) => {
  const sql = postgres(connectionString);
  const now = new Date();
  t.after(async () => {
    await sql`delete from intent_responses`;
    await sql`delete from landing_links`;
    await sql`delete from candidates`;
    await sql`delete from jobs`;
    await sql`delete from source_connections`;
    await sql.end();
  });

  const [source] = await sql`
    insert into source_connections (provider, environment, display_name, status)
    values ('landing-link-test', 'test', 'Landing Link Test', 'active')
    returning id
  `;
  const sourceId = source.id;
  const [job] = await sql`
    insert into jobs (
      source_connection_id, external_id, mapping_version, title, company_name, category,
      city, salary_min, salary_max, status, days_without_recommendation,
      eligibility_evidence, portal_url, job_description
    ) values (
      ${sourceId}, 'landing-job-test', 'v1', 'Landing Job Test', 'Fixture Co',
      'Engineering', 'Shanghai', 20, 30, 'active', 14,
      '{"source":"fixture"}', 'https://portal.invalid/landing-test',
      '完整职责描述：负责前端架构与工程效率，期待成熟项目经验。'
    )
    returning id
  `;
  const [candidate] = await sql`
    insert into candidates (source_connection_id, external_id, display_name)
    values (${sourceId}, 'landing-cand-test', 'Candidate Test')
    returning id
  `;

  const token = generateLandingToken();
  const tokenHash = hashLandingToken(token);
  const link = await createLandingLink(sql, {
    jobId: job.id,
    candidateId: candidate.id,
    tokenHash,
    expiresAt: new Date(now.getTime() + 30 * 86400000),
    createdBy: null,
  });
  assert.ok(link.id);
  assert.equal(link.jobId, job.id);
  assert.equal(link.candidateId, candidate.id);

  // ① 库中只存哈希，不存明文令牌
  const [stored] = await sql`select token_hash from landing_links where id = ${link.id}`;
  assert.equal(stored.token_hash, tokenHash);
  assert.notEqual(stored.token_hash, token);
  assert.ok(!stored.token_hash.includes(token.slice(0, 8)));

  // ② 有效令牌可查并联出脱敏职位字段
  const found = await findValidLandingLinkByTokenHash(sql, { tokenHash, now });
  assert.ok(found);
  assert.equal(found.title, "Landing Job Test");
  assert.equal(found.city, "Shanghai");
  assert.equal(found.salaryMin, 20);
  assert.equal(found.jobDescription, "完整职责描述：负责前端架构与工程效率，期待成熟项目经验。");

  // ③ 未知令牌 → null
  assert.equal(
    await findValidLandingLinkByTokenHash(sql, {
      tokenHash: hashLandingToken("unknown-token"),
      now,
    }),
    null,
  );

  // ④ 过期令牌 → null
  await createLandingLink(sql, {
    jobId: job.id,
    candidateId: candidate.id,
    tokenHash: hashLandingToken("expired-token"),
    expiresAt: new Date(now.getTime() - 1000),
    createdBy: null,
  });
  assert.equal(
    await findValidLandingLinkByTokenHash(sql, {
      tokenHash: hashLandingToken("expired-token"),
      now,
    }),
    null,
  );

  // ⑤ 撤销后 → null
  const revoked = await revokeLandingLink(sql, { id: link.id, revokedBy: null, now });
  assert.ok(revoked);
  assert.ok(revoked.revokedAt);
  assert.equal(
    await findValidLandingLinkByTokenHash(sql, { tokenHash, now }),
    null,
  );

  // ⑥ 分页
  const paged = await listLandingLinks(sql, { page: 1, pageSize: 10 });
  assert.equal(paged.total, 2);
  assert.equal(paged.list.length, 2);
  assert.ok(paged.list[0].jobTitle === "Landing Job Test");
});
