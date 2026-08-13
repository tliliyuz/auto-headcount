import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import {
  getMatchById,
  listMatches,
} from "../lib/jobs/match-read-repository.mjs";
import {
  replaceMatchDimensions,
  updateMatchStatus,
  upsertCandidate,
  upsertMatch,
} from "../lib/jobs/match-repository.mjs";
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
    category: "Engineering",
    city: "Shanghai",
    salaryMin: 20,
    salaryMax: 30,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

async function seedJob(sql, sourceId, externalId, ageDays) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId: runId,
    rawPayload: { job_id: externalId },
    job: fixtureJob(externalId, ageDays),
    encryption,
    operabilityStatus: "actionable",
  });
  await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });
  return jobId;
}

async function cleanup(sql, sourceId) {
  if (sourceId) {
    // FK 顺序：先收集本源候选人 id → 删 matches（match_dimensions 级联）→ 再删 candidates（matches 引用 RESTRICT）
    const referenced = await sql`
      select distinct m.candidate_id as id
      from matches m join jobs j on j.id = m.job_id
      where j.source_connection_id = ${sourceId}
    `;
    await sql`delete from matches where job_id in (select id from jobs where source_connection_id = ${sourceId})`;
    if (referenced.length) {
      await sql`delete from candidates where id = any(${referenced.map((r) => r.id)})`;
    }
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  await sql.end();
}

test(
  "匹配读仓储：列表/详情白名单投影（打码名、无 portal_url/联系方式）、分页、维度关联",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-read-${marker}`,
      environment: "test",
      displayName: "Fixture Match Read",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, "read-j1", 9);

      const cand1 = await upsertCandidate(sql, {
        externalId: "read-c1",
        displayName: "张**",
        summary: "示例公司-算法工程师",
      });
      const match = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 88,
        band: "high",
        ruleVersion: 1,
        scoreStatus: "cached",
        evidence: ["5 年经验"],
        missing: ["缺海外"],
        risk: ["在职"],
      });
      await replaceMatchDimensions(sql, {
        matchId: match.id,
        dimensions: [
          { dimension: "技能", score: 90 },
          { dimension: "地点", score: 80 },
        ],
      });

      // 列表投影：打码名、无 portal_url/联系方式
      const list = await listMatches(sql, { jobId, pageSize: 100 });
      assert.equal(list.total, 1);
      const row = list.list[0];
      assert.equal(row.candidateName, "张**");
      assert.equal(row.score, 88);
      assert.equal(row.band, "high");
      assert.equal(row.status, "generated");
      assert.equal(row.jobTitle, "Job read-j1");
      assert.ok(!("portalUrl" in row), "不投影 portal_url");
      assert.ok(Object.keys(row).every((k) => !k.toLowerCase().includes("contact")), "无联系方式字段");

      // 详情：含维度分
      const detail = await getMatchById(sql, match.id);
      assert.equal(detail.dimensions.length, 2);
      assert.deepEqual(
        detail.dimensions.map((d) => [d.dimension, d.score]),
        [
          ["技能", 90],
          ["地点", 80],
        ],
      );

      // 分页一致性
      const page = await listMatches(sql, { jobId, page: 1, pageSize: 1 });
      assert.equal(page.total, 1);
      assert.equal(page.list.length, 1);

      // 未知 id → undefined（路由 404）
      assert.equal(await getMatchById(sql, randomUUID()), undefined);
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "匹配审核：generated → approved/rejected；已审核不可重复流转（409 语义）",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-review-${marker}`,
      environment: "test",
      displayName: "Fixture Match Review",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, "review-j1", 9);
      const cand1 = await upsertCandidate(sql, {
        externalId: "review-c1",
        displayName: "李**",
        summary: "示例公司-产品经理",
      });
      const match = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 80,
        band: "medium",
        ruleVersion: 1,
        scoreStatus: "cached",
      });

      // approve → approved
      const approved = await updateMatchStatus(sql, {
        id: match.id,
        status: "approved",
      });
      assert.equal(approved, match.id);
      const afterApprove = await getMatchById(sql, match.id);
      assert.equal(afterApprove.status, "approved");

      // 已审核不可重复流转 → null（路由 409）
      const again = await updateMatchStatus(sql, {
        id: match.id,
        status: "rejected",
      });
      assert.equal(again, null, "已审核不可重复流转");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);
