import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { runMatchSync } from "../lib/jobs/match-sync.mjs";
import {
  getMatchById,
  listMatches,
} from "../lib/jobs/match-read-repository.mjs";
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
            ${sql.json({ min_experience_years: requirements.minExperienceYears ?? 0 })})
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

/** 清理：先删本源 matches → 再删本源创建的所有候选人（profile/候选人）+ job_requirements + jobs 等。 */
async function cleanup(sql, { sourceId, candidateIds }) {
  if (sourceId) {
    await sql`delete from matches where job_id in (select id from jobs where source_connection_id = ${sourceId})`;
    if (candidateIds?.length) {
      await sql`delete from candidate_profiles where candidate_id = any(${candidateIds})`;
      await sql`delete from candidates where id = any(${candidateIds})`;
    }
    await sql`delete from job_requirements where job_id in (select id from jobs where source_connection_id = ${sourceId})`;
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
  "match-sync：本地评分落库（总分/分带/维度/输入哈希），硬过滤不过不入池，可复算",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-${marker}`,
      environment: "test",
      displayName: "Fixture Match Sync",
    };
    let sourceId;
    const candidateIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, `match-j1-${marker}`, REQUIREMENTS);
      // 候选人：合格（全匹配）+ 不合格（缺技能、年限不足）
      candidateIds.push(
        await seedCandidate(sql, {
          externalId: ext("cand-good"),
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
        }),
      );
      candidateIds.push(
        await seedCandidate(sql, {
          externalId: ext("cand-noskill"),
          displayName: "李**",
          profile: {
            skills: ["Java"],
            experienceYears: 6,
            location: "上海",
            education: "本科",
            seniority: "高级",
            industry: "互联网",
            expectedSalaryMin: 30,
            expectedSalaryMax: 50,
            activityUpdatedAt: new Date(),
            summary: "示例公司-Java工程师",
          },
        }),
      );
      candidateIds.push(
        await seedCandidate(sql, {
          externalId: ext("cand-lowyears"),
          displayName: "王**",
          profile: {
            skills: ["Node.js", "PostgreSQL"],
            experienceYears: 2,
            location: "上海",
            education: "本科",
            seniority: "高级",
            industry: "互联网",
            expectedSalaryMin: 30,
            expectedSalaryMax: 50,
            activityUpdatedAt: new Date(),
            summary: "示例公司-初级工程师",
          },
        }),
      );

      const outcome = await runMatchSync({ sql, source, jobIds: [jobId] });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.jobsQueried, 1);
      assert.equal(outcome.stats.matchesStored, 1, "只有硬过滤通过的候选人入池");
      assert.equal(outcome.stats.hardFiltered, 2);

      const result = await listMatches(sql, { jobId, pageSize: 100 });
      assert.equal(result.total, 1);
      const m = result.list[0];
      assert.equal(m.candidateName, "张**");
      assert.ok(m.score >= 85, "全匹配候选人应高匹配");
      assert.equal(m.band, "high");
      assert.equal(m.scoreStatus, "local_computed");
      assert.ok(m.inputHash, "保存输入哈希（可复算）");
      assert.equal(m.externalScore, null, "未提供 mcp 时外部对照为 null");

      // 可复算：重跑同结果（唯一 (job,candidate,rule_version)）
      const second = await runMatchSync({ sql, source, jobIds: [jobId] });
      assert.equal(second.status, "succeeded");
      const result2 = await listMatches(sql, { jobId, pageSize: 100 });
      assert.equal(result2.total, 1, "幂等重跑不产生重复");
      assert.equal(result2.list[0].score, m.score, "本地评分可复算");

      // 详情含维度分
      const detail = await getMatchById(sql, m.id);
      assert.equal(detail.dimensions.length, 7);
      assert.ok(detail.evidence.length >= 1, "含命中证据");
      assert.ok(detail.risk.length >= 0);
      assert.ok(!("portalUrl" in detail), "不投影 portal_url");
    } finally {
      await cleanup(sql, { sourceId, candidateIds });
    }
  },
);

test(
  "match-sync：外部对照（提供 mcp 时 match_candidates 结果写入 external_*，不作为权威分）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-${marker}`,
      environment: "test",
      displayName: "Fixture Match External",
    };
    let sourceId;
    const candidateIds = [];
    const ext = (suffix) => `${suffix}-${marker}`;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobExtId = `match-e1-${marker}`;
      const jobId = await seedJob(sql, sourceId, jobExtId, REQUIREMENTS);
      candidateIds.push(
        await seedCandidate(sql, {
          externalId: ext("cand-ext"),
          displayName: "赵**",
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
        }),
      );

      // 供应方外部对照：cand-ext 返回 cached 78/moderate
      const callTool = async (toolName, args) => {
        assert.equal(toolName, "wb.jobs.match_candidates");
        assert.equal(args.job_id, jobExtId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                Code: 0,
                Message: "success",
                Data: {
                  source_id: "match-e1",
                  source_type: "job",
                  total: 1,
                  page: 1,
                  page_size: 50,
                  total_pages: 1,
                  matches: [
                    {
                      candidate_id: ext("cand-ext"),
                      is_own: true,
                      owner_id: "o-1",
                      owner_name: "示例顾问",
                      score_status: "cached",
                      total_score: 78,
                      tier: "moderate",
                      candidate_summary: {
                        candidate_id: ext("cand-ext"),
                        name: "赵**",
                        current_title: "工程师",
                        current_company: "示例公司",
                        city: "上海",
                        experience_years: 6,
                        resume_summary: "示例公司-工程师",
                      },
                    },
                  ],
                },
              }),
            },
          ],
        };
      };

      const outcome = await runMatchSync({
        sql,
        source,
        jobIds: [jobId],
        mcp: { callTool },
      });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.matchesStored, 1);

      const result = await listMatches(sql, { jobId, pageSize: 100 });
      const m = result.list[0];
      // 权威分 = 本地分（可能 ≥85）；外部对照单独存 external_*
      assert.equal(m.scoreStatus, "local_computed");
      assert.ok(m.score >= 85, "本地评分是权威分");
      assert.equal(m.externalScore, 78, "外部对照记录供应方分数");
      assert.equal(m.externalTier, "moderate");
      assert.equal(m.externalScoreStatus, "cached");
    } finally {
      await cleanup(sql, { sourceId, candidateIds });
    }
  },
);
