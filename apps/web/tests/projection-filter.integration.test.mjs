import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { runProjectionFilterSync } from "../lib/jobs/projection-filter-sync.mjs";
import { runAutomaticMatchPipeline } from "../lib/jobs/automatic-match-pipeline.mjs";
import { createFakeDetailScoringAdapter } from "../lib/matching/fake-detail-scoring-adapter.mjs";
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

/** seed 候选人 + 画像（candidates.source_connection_id NOT NULL，迁移 0010）。 */
async function seedCandidate(sql, { sourceConnectionId, externalId, displayName, profile }) {
  const [cand] = await sql`
    insert into candidates (source_connection_id, external_id, display_name, summary)
    values (${sourceConnectionId}, ${externalId}, ${displayName}, ${profile.summary ?? null})
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
    await sql`delete from match_dimensions where match_id in (select id from matches where job_id = any(${projJobIds}))`;
    await sql`delete from matches where job_id = any(${projJobIds})`;
    await sql`
      delete from llm_score_runs where filter_result_id in (
        select fr.id from match_filter_results fr
        join job_match_projections jp on jp.id = fr.job_projection_id
        where jp.job_id = any(${projJobIds})
      )
    `;
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
        sourceConnectionId: sourceId,
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
        sourceConnectionId: sourceId,
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

      const pipelineEnv = {
        APP_ENV: "test",
        APP_ENCRYPTION_KEY: encryption.key,
        APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion,
      };
      const scored = await runAutomaticMatchPipeline({ sql, env: pipelineEnv });
      assert.equal(scored.status, "succeeded");
      assert.equal(scored.stats.scored, 1);
      const [stored] = await sql`
        select m.status, m.score_status, m.job_projection_id, m.candidate_projection_id,
          m.filter_result_id, m.llm_score_run_id, m.aggregation_rule_version,
          (select count(*)::int from match_dimensions md where md.match_id = m.id) as dimension_count
        from matches m where m.job_id = ${jobId} and m.candidate_id = ${goodId}
      `;
      assert.equal(stored.status, "pending_review");
      assert.equal(stored.score_status, "llm_aggregated");
      assert.equal(stored.dimension_count, 7);
      assert.equal(stored.aggregation_rule_version, "aggregation/v3");

      const idempotent = await runAutomaticMatchPipeline({ sql, env: pipelineEnv });
      assert.equal(idempotent.stats.scored, 0, "相同版本组合不重复调用评分适配器");
      const runCount = await sql`
        select count(*)::int as n from llm_score_runs where filter_result_id = (
          select id from match_filter_results where job_projection_id = ${jp.id} and candidate_projection_id = ${cp.id}
        )
      `;
      assert.equal(runCount[0].n, 1);

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

      // 迁移 0016：候选输入变化 → 新候选人投影 + 新过滤结果 + 新 rule_version →
      // 管线重跑产生第二条 match，旧 match 标 superseded，每 (job,candidate) 只留 1 条 active。
      const changedDetails = new Map([
        [
          goodId,
          {
            career_history: [
              "某互联网公司后端开发（公司名已泛化）",
              "某金融科技公司架构（新增一段经历）",
            ],
            project_highlights: ["参与某高并发项目（项目名已泛化）"],
          },
        ],
      ]);
      const changed = await runProjectionFilterSync({
        sql,
        source,
        jobIds: [jobId],
        candidateRedactedDetails: changedDetails,
        encryption,
      });
      assert.equal(changed.status, "succeeded");
      const [newCp] = await sql`
        select id from candidate_match_projections
        where candidate_id = ${goodId} and id <> ${cp.id}
        order by created_at desc limit 1
      `;
      assert.ok(newCp, "候选输入变化 → 新候选人投影");
      const [newFr] = await sql`
        select id, combined_input_hash from match_filter_results
        where candidate_projection_id = ${newCp.id}
        order by created_at desc limit 1
      `;
      assert.ok(newFr, "新候选人投影 → 新过滤结果");
      assert.notEqual(newFr.combined_input_hash, fr.combined_input_hash, "组合输入哈希变化");

      const rescored = await runAutomaticMatchPipeline({ sql, env: pipelineEnv });
      assert.equal(rescored.status, "succeeded");
      assert.equal(rescored.stats.scored, 1, "新输入组合重新评分");
      const pairRows = await sql`
        select m.rule_version as "ruleVersion", m.is_superseded as "isSuperseded", m.status
        from matches m
        where m.job_id = ${jobId} and m.candidate_id = ${goodId}
        order by m.created_at, m.id
      `;
      assert.equal(pairRows.length, 2, "输入变化 → 同 (job,candidate) 两条 match");
      assert.equal(pairRows[0].isSuperseded, true, "旧 match superseded");
      assert.equal(pairRows[0].status, "pending_review", "旧行审核态保留");
      assert.equal(pairRows[1].isSuperseded, false, "新 match active");
      const [activeN] = await sql`
        select count(*)::int as n from matches
        where job_id = ${jobId} and candidate_id = ${goodId} and not is_superseded
      `;
      assert.equal(activeN.n, 1, "每 (job,candidate) 只留 1 条 active");
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
        sourceConnectionId: sourceId,
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

test(
  "职位去重：同 JD 多城市合并为代表——1 次 LLM、代表出 match、locations 城市并集、幂等",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-pf-dedup-${marker}`,
      environment: "test",
      displayName: "Fixture Projection Filter Dedup",
    };
    let sourceId;
    const candidateIds = [];
    const jobIds = [];
    const JD_TEXT = "岗位职责：负责大模型应用与数据智能系统开发。任职要求：熟悉 Node.js 与 PostgreSQL。";
    const REQUIREMENTS = {
      skills: ["Node.js", "PostgreSQL"],
      seniority: "高级",
      education: "本科",
      salaryMin: 30,
      salaryMax: 60,
      minExperienceYears: 5,
    };

    async function seedJobWithJd(externalId, city) {
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      const { jobId } = await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: runId,
        rawPayload: { job_id: externalId },
        job: { ...fixtureJob(externalId, 9), city },
        encryption,
        operabilityStatus: "actionable",
      });
      await sql`update jobs set job_description = ${JD_TEXT} where id = ${jobId}`;
      await sql`
        insert into job_requirements (job_id, skills, seniority, education, salary_min, salary_max, constraints)
        values (${jobId}, ${sql.json(REQUIREMENTS.skills)}, ${REQUIREMENTS.seniority},
                ${REQUIREMENTS.education}, ${REQUIREMENTS.salaryMin}, ${REQUIREMENTS.salaryMax},
                ${sql.json({ min_experience_years: REQUIREMENTS.minExperienceYears })}) on conflict (job_id) do nothing
      `;
      await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
      return jobId;
    }

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      jobIds.push(await seedJobWithJd(`dedup-j1-${marker}`, "上海"));
      jobIds.push(await seedJobWithJd(`dedup-j2-${marker}`, "广州"));

      const candidateId = await seedCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: `dedup-c1-${marker}`,
        displayName: "张**",
        profile: {
          skills: ["Node.js", "PostgreSQL", "React"],
          experienceYears: 7,
          location: "广州",
          education: "硕士",
          seniority: "高级",
          industry: "互联网",
          expectedSalaryMin: 35,
          expectedSalaryMax: 55,
          activityUpdatedAt: new Date(Date.now() - 10 * 86400000),
          summary: "示例公司-高级工程师",
        },
      });
      candidateIds.push(candidateId);
      const redactedDetails = new Map([
        [candidateId, { career_history: ["某互联网公司后端开发（公司名已泛化）"], project_highlights: [] }],
      ]);

      const phase1 = await runProjectionFilterSync({
        sql,
        source,
        jobIds,
        candidateRedactedDetails: redactedDetails,
        encryption,
      });
      assert.equal(phase1.status, "succeeded");
      assert.equal(phase1.stats.filterPassed, 2, "v3 城市不硬门槛 → 两个城市变体都通过硬过滤");

      const base = createFakeDetailScoringAdapter();
      const seen = [];
      const cap = {
        metadata: base.metadata,
        async score(input) {
          seen.push(input);
          return base.score(input);
        },
      };
      const env = { APP_ENV: "test", APP_ENCRYPTION_KEY: encryption.key, APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion };
      const outcome = await runAutomaticMatchPipeline({ sql, env, adapter: cap });
      assert.equal(outcome.status, "succeeded");

      assert.equal(seen.length, 1, "同 JD 两个变体只应调 1 次 LLM");
      assert.deepEqual(
        [...seen[0].jobProjection.hard_requirements.locations].sort(),
        ["广州", "上海"].sort(),
        "代表职位 locations 应为组内城市并集（顺序无关）",
      );

      const matchCounts = await sql`
        select job_id, count(*)::int as n from matches
        where job_id = any(${jobIds}) group by job_id
      `;
      assert.equal(matchCounts.length, 1, "只有代表职位出 match");
      assert.equal(matchCounts[0].n, 1);

      const [runs] = await sql`
        select count(*)::int as n from llm_score_runs
        where filter_result_id in (
          select fr.id from match_filter_results fr
          join job_match_projections jp on jp.id = fr.job_projection_id
          where jp.job_id = any(${jobIds})
        )
      `;
      assert.equal(runs.n, 1, "只对代表 filter_result 落 1 条 run");

      // 幂等重跑：scored=0，组内 match 总数仍 1（防代表先成功→下一轮落到变体的 fall-through）
      const again = await runAutomaticMatchPipeline({ sql, env, adapter: cap });
      assert.equal(again.stats.scored, 0);
      const [matchTotal] = await sql`
        select count(*)::int as n from matches where job_id = any(${jobIds})
      `;
      assert.equal(matchTotal.n, 1, "幂等重跑不新增跨 job match");
    } finally {
      await cleanup(sql, { sourceId, candidateIds, jobIds });
    }
  },
);
