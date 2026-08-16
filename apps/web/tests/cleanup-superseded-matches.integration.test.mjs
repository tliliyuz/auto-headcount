import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { cleanupSupersededMatches } from "../scripts/cleanup-superseded-matches.mjs";
import { upsertCandidate, upsertMatch } from "../lib/jobs/match-repository.mjs";
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

const SAME_JD = "知识图谱工程师，负责 Text2SQL 数据智能方向，要求扎实的算法功底与工程落地能力。";

function fixtureJob(externalId, city) {
  return {
    externalId,
    title: `Job ${externalId}`,
    companyName: "Fixture Company",
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays: 9,
    lastRecommendationAt: null,
    category: "互联网",
    city,
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

async function seedJobWithJd(sql, sourceId, externalId, city, jd) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId: runId,
    rawPayload: { job_id: externalId },
    job: fixtureJob(externalId, city),
    encryption,
    operabilityStatus: "actionable",
  });
  await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
  if (jd !== null) {
    await sql`update jobs set job_description = ${jd} where id = ${jobId}`;
  }
  return jobId;
}

test(
  "历史清理（问题 4）：删 fixture 匹配 + 每 (JD组,候选人) 保留代表 match 其余 superseded，无 JD 不误伤",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-cleanup-${marker}`,
      environment: "test",
      displayName: "Fixture Cleanup",
    };
    let sourceId;
    const jobIds = [];
    const candidateIds = [];

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      // 同 JD 城市变体（jdHash 组）：job-a 与 job-b
      const jobA = await seedJobWithJd(sql, sourceId, `cl-a-${marker}`, "上海", SAME_JD);
      const jobB = await seedJobWithJd(sql, sourceId, `cl-b-${marker}`, "北京", SAME_JD);
      jobIds.push(jobA, jobB);
      // 无 JD 职位（自身成组，不应被误伤）
      const jobC = await seedJobWithJd(sql, sourceId, `cl-c-${marker}`, "广州", null);
      jobIds.push(jobC);

      const candReal = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: `cl-cand-${marker}`,
        displayName: "郑**",
        summary: "示例公司-工程师",
      });
      candidateIds.push(candReal);
      // 预览 fixture 候选人（假数据，应直接删）
      const candFixture = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: `cl-fixture-${marker}`,
        displayName: "预览候选人",
        summary: "预览数据",
      });
      candidateIds.push(candFixture);

      // 去重部署前：同 JD 两个变体各自出 match（挂各自 job）
      await upsertMatch(sql, {
        jobId: jobA,
        candidateId: candReal,
        score: 74,
        band: "low",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
      });
      await upsertMatch(sql, {
        jobId: jobB,
        candidateId: candReal,
        score: 80,
        band: "medium",
        ruleVersion: 2,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
      });
      // 无 JD 职位的 match（自成组，不应被清理规则 supersede）
      await upsertMatch(sql, {
        jobId: jobC,
        candidateId: candReal,
        score: 70,
        band: "low",
        ruleVersion: 3,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
      });
      // fixture 匹配
      await upsertMatch(sql, {
        jobId: jobA,
        candidateId: candFixture,
        score: 78,
        band: "medium",
        ruleVersion: 1,
        status: "approved",
        scoreStatus: "llm_aggregated",
      });

      const [before] = await sql`select count(*)::int as n from matches where job_id = any(${jobIds})`;
      assert.equal(before.n, 4, "清理前 4 条");

      const result = await cleanupSupersededMatches(sql);

      // fixture 匹配被删（假数据，无审计价值）
      const fixtureRows = await sql`
        select count(*)::int as n from matches where job_id = any(${jobIds})
          and candidate_id = ${candFixture}
      `;
      assert.equal(fixtureRows[0].n, 0, "fixture 匹配直接删除");
      // 无 JD 职位的 match 保留 active
      const noJd = await sql`
        select m.is_superseded from matches m where m.job_id = ${jobC} and m.candidate_id = ${candReal}
      `;
      assert.equal(noJd[0].is_superseded, false, "无 JD 职位不误伤");

      // 同 JD 组：保留代表（min job_id），其余 superseded
      const groupJobIds = [jobA, jobB];
      const [groupRows] = await sql`
        select count(*)::int as total,
          count(*) filter (where not is_superseded)::int as active,
          count(*) filter (where is_superseded)::int as superseded
        from matches m where m.job_id = any(${groupJobIds})
          and m.candidate_id = ${candReal}
      `;
      assert.equal(groupRows.total, 2, "同 JD 组两条 match 保留（不硬删，保审计）");
      assert.equal(groupRows.active, 1, "组内只留 1 条 active");
      assert.equal(groupRows.superseded, 1, "其余 superseded");

      const [repJob] = await sql`
        select job_id from matches m where m.job_id = any(${groupJobIds})
          and m.candidate_id = ${candReal} and not m.is_superseded
      `;
      const [minJob] = await sql`
        select id from jobs where id in (${jobA}, ${jobB}) order by id limit 1
      `;
      assert.equal(repJob.job_id, minJob.id, "active 挂在组内最小 job_id（代表）");

      assert.equal(typeof result.deletedFixtures, "number", "脚本返回删除数");
      assert.equal(typeof result.superseded, "number", "脚本返回 supersede 数");
    } finally {
      // 清理：先删 matches → candidates → jobs（FK 顺序）
      await sql`delete from matches where job_id = any(${jobIds})`;
      if (candidateIds.length) {
        await sql`delete from candidates where id = any(${candidateIds})`;
      }
      await sql`delete from jobs where source_connection_id = ${sourceId}`;
      await sql`delete from raw_records where source_connection_id = ${sourceId}`;
      await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
      await sql`delete from source_connections where id = ${sourceId}`;
      await sql.end();
    }
  },
);
