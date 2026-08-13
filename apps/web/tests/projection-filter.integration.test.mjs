import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { runProjectionFilterSync } from "../lib/jobs/projection-filter-sync.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

function fixtureJob(externalId, ageDays) {
  return {
    externalId,
    title: `Job ${externalId}`,
    companyName: "Fixture Company",
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays,
    lastRecommendationAt: null,
    category: "互联网",
    city: "上海",
    salaryMin: 30,
    salaryMax: 60,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

/** seed 可操作职位 + job_requirements。 */
async function seedJob(sql, sourceId, externalId, requirements) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId: runId,
    rawPayload: { job_id: externalId },
    job: fixtureJob(externalId, 9),
    encryption,
    operabilityStatus: "actionable",
  });
  await sql`
    insert into job_requirements (job_id, skills, seniority, education, salary_min, salary_max, constraints)
    values (${jobId}, ${sql.json(requirements.skills ?? [])}, ${requirements.seniority ?? null},
            ${requirements.education ?? null}, ${requirements.salaryMin ?? null}, ${requirements.salaryMax ?? null},
            ${sql.json({ min_experience_years: requirements.minExperienceYears ?? 0 })}) on conflict (job_id) do nothing
  `;
  await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
  return jobId;
}

/** seed 候选人 + 画像。 */
async function seedCandidate(sql, { externalId, displayName, profile }) {
  const [cand] = await sql`
    insert into candidates (external_id, display_name, summary)
    values (${externalId}, ${displayName}, ${profile.summary ?? null})
    returning id
  `;
  await sql`
    insert into candidate_profiles (
      candidate_id, skills, experience_years, location, education, seniority,
      industry, expected_salary_min, expected_salary_max, activity_updated_at
    ) values (
      ${cand.id}, ${sql.json(profile.skills ?? [])}, ${profile.experienceYears ?? null},
      ${profile.location ?? null}, ${profile.education ?? null}, ${profile.seniority ?? null},
      ${profile.industry ?? null}, ${profile.expectedSalaryMin ?? null},
      ${profile.expectedSalaryMax ?? null}, ${profile.activityUpdatedAt ?? null}
    )
  `;
  return cand.id;
}

/** 清理：按 source 删除投影/过滤/匹配/候选人/职位等（FK 顺序）。 */
async function cleanup(sql, { sourceId, candidateIds, jobIds }) {
  if (sourceId) {
    const projJobIds = jobIds ?? [];
    await sql`
      delete from match_filter_results
      where job_projection_id in (
        select id from job_match_projections where job_id = any(${projJobIds})
      ) or candidate_projection_id in (
        select id from candidate_match_projections where candidate_id = any(${candidateIds})
      )
    `;
    await sql`
      delete from job_match_projections where job_id = any(${projJobIds})
    `;
    await sql`
      delete from candidate_match_projections where candidate_id = any(${candidateIds})
    `;
    await sql`delete from match_dimensions where match_id in (select id from matches where job_id = any(${projJobIds}))`;
    await sql`delete from matches where job_id = any(${projJobIds})`;
    if (candidateIds?.length) {
      await sql`delete from candidate_profiles where candidate_id = any(${candidateIds})`;
      await sql`delete from candidates where id = any(${candidateIds})`;
    }
    await sql`delete from job_requirements where job_id = any(${projJobIds})`;
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  await sql.end();
}

const REQUIREMENTS = {
  skills: ["Node.js", "PostgreSQL"],
  seniority: "高级",
  education: "本科",
  salaryMin: 30,
  salaryMax: 60,
  minExperienceYears: 5,
};

test(
  "projection-filter：投影落库（consumable）+ PII 拒绝跳过 + 硬过滤原因码 + 幂等重跑",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-pf-${marker}`,
      environment: "test",
      displayName: "Fixture Projection Filter",
    };
    let sourceId;
    const candidateIds = [];
    const jobIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, `pf-j1-${marker}`, REQUIREMENTS);
      jobIds.push(jobId);

      // 合格候选人（全匹配）+ 残留 PII 候选人（应被投影层拒绝）
      const goodId = await seedCandidate(sql, {
        externalId: ext("pf-cand-good"),
        displayName: "张**",
        profile: {
          skills: ["Node.js", "PostgreSQL", "React"],
          experienceYears: 7,
          location: "上海",
          education: "硕士",
          seniority: "高级",
          industry: "互联网",
          expectedSalaryMin: 35,
          expectedSalaryMax: 55,
          activityUpdatedAt: new Date(Date.now() - 10 * 86400000),
          summary: "示例公司-高级工程师",
        },
      });
      candidateIds.push(goodId);
      const piiId = await seedCandidate(sql, {
        externalId: ext("pf-cand-pii"),
        displayName: "李**",
        profile: {
          skills: ["Node.js", "PostgreSQL"],
          experienceYears: 6,
          location: "上海",
          education: "本科",
          seniority: "高级",
          industry: "互联网",
          expectedSalaryMin: 30,
          expectedSalaryMax: 50,
          activityUpdatedAt: new Date(),
          summary: "示例公司-工程师",
        },
      });
      candidateIds.push(piiId);

      const redactedDetails = new Map([
        [
          goodId,
          {
            career_history: ["某互联网公司后端开发（公司名已泛化）"],
            project_highlights: ["参与某高并发项目（项目名已泛化）"],
          },
        ],
        // piiId 的脱敏详情残留手机号 → 投影层拒绝
        [
          piiId,
          {
            career_history: ["某公司任职，联系电话 13800138000"],
            project_highlights: [],
          },
        ],
      ]);

      const outcome = await runProjectionFilterSync({
        sql,
        source,
        jobIds: [jobId],
        candidateRedactedDetails: redactedDetails,
        encryption,
      });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.jobsProjected, 1);
      assert.equal(outcome.stats.candidatesQueried, 2);
      assert.equal(outcome.stats.candidatesProjected, 1, "只有 PII 扫描通过的候选人产出消费态投影");
      assert.equal(outcome.stats.piiRejected, 1, "残留 PII 候选人被投影层拒绝");
      assert.equal(outcome.stats.filterPassed, 1, "合格候选人与职位硬过滤通过");
      assert.equal(outcome.stats.filterRejected, 0);

      // 职位投影落库（consumable）
      const [jp] = await sql`
        select id, status, display_summary, requirements
        from job_match_projections where job_id = ${jobId}
      `;
      assert.ok(jp, "职位投影已落库");
      assert.equal(jp.status, "consumable");
      assert.ok(jp.display_summary.length <= 150);
      assert.equal(jp.requirements.hard_requirements.required_skills[0], "Node.js");

      // 合格候选人投影落库（consumable，residual_pii_scan=passed）；PII 候选人不落消费态投影
      const [cp] = await sql`
        select id, status, profile, redaction_report
        from candidate_match_projections where candidate_id = ${goodId}
      `;
      assert.ok(cp, "合格候选人投影已落库");
      assert.equal(cp.status, "consumable");
      assert.equal(cp.redaction_report.residual_pii_scan, "passed");
      const piiRows = await sql`
        select id from candidate_match_projections where candidate_id = ${piiId}
      `;
      assert.equal(piiRows.length, 0, "残留 PII 候选人不落消费态投影");

      // 过滤结果落库（通过、原因码为空）
      const [fr] = await sql`
        select passed, reason_codes, combined_input_hash
        from match_filter_results where job_projection_id = ${jp.id} and candidate_projection_id = ${cp.id}
      `;
      assert.ok(fr, "过滤结果已落库");
      assert.equal(fr.passed, true);
      assert.deepEqual(fr.reason_codes, []);

      // 幂等重跑：投影/过滤结果不重复（版本不覆盖 + 唯一约束）
      const second = await runProjectionFilterSync({
        sql,
        source,
        jobIds: [jobId],
        candidateRedactedDetails: redactedDetails,
        encryption,
      });
      assert.equal(second.status, "succeeded");
      const jpCount = await sql`
        select count(*)::int as n from job_match_projections where job_id = ${jobId}
      `;
      assert.equal(jpCount[0].n, 1, "同输入重跑不新增职位投影");
      const frCount = await sql`
        select count(*)::int as n from match_filter_results where job_projection_id = ${jp.id}
      `;
      assert.equal(frCount[0].n, 1, "同投影对重跑不新增过滤结果");
    } finally {
      await cleanup(sql, { sourceId, candidateIds, jobIds });
    }
  },
);

test(
  "projection-filter：源内容变化 → 新投影行（版本不覆盖，旧行保留）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-pf2-${marker}`,
      environment: "test",
      displayName: "Fixture Projection Filter V2",
    };
    let sourceId;
    const candidateIds = [];
    const jobIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, `pf2-j1-${marker}`, REQUIREMENTS);
      jobIds.push(jobId);
      const candId = await seedCandidate(sql, {
        externalId: ext("pf2-cand"),
        displayName: "王**",
        profile: {
          skills: ["Node.js", "PostgreSQL"],
          experienceYears: 6,
          location: "上海",
          education: "本科",
          seniority: "高级",
          industry: "互联网",
          expectedSalaryMin: 30,
          expectedSalaryMax: 50,
          activityUpdatedAt: new Date(),
          summary: "示例公司-工程师",
        },
      });
      candidateIds.push(candId);
      const redactedDetails = new Map([
        [
          candId,
          {
            career_history: ["某互联网公司后端开发（公司名已泛化）"],
            project_highlights: ["参与某项目（项目名已泛化）"],
          },
        ],
      ]);

      await runProjectionFilterSync({
        sql,
        source,
        jobIds: [jobId],
        candidateRedactedDetails: redactedDetails,
        encryption,
      });

      // 改变职位源内容（薪资上界）→ 重新生成投影 → 新 input_hash → 新投影行
      await sql`
        update jobs set salary_max = 90, updated_at = now() where id = ${jobId}
      `;
      const before = await sql`
        select count(*)::int as n from job_match_projections where job_id = ${jobId}
      `;
      assert.equal(before[0].n, 1);

      await runProjectionFilterSync({
        sql,
        source,
        jobIds: [jobId],
        candidateRedactedDetails: redactedDetails,
        encryption,
      });

      const after = await sql`
        select input_hash, requirements, created_at
        from job_match_projections where job_id = ${jobId}
        order by created_at, id
      `;
      assert.equal(after.length, 2, "源内容变化 → 新投影行（版本不覆盖）");
      assert.notEqual(after[0].input_hash, after[1].input_hash, "输入哈希随源内容变化");
      assert.equal(
        after[1].requirements.hard_requirements.salary.maximum,
        90,
        "新投影反映最新源内容（薪资上界 90）",
      );
    } finally {
      await cleanup(sql, { sourceId, candidateIds, jobIds });
    }
  },
);
