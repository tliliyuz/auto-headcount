import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import {
  getMatchById,
  listMatches,
} from "../lib/jobs/match-read-repository.mjs";
import { listCandidates } from "../lib/jobs/candidate-read-repository.mjs";
import {
  findApprovedMatchForJobCandidate,
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
        sourceConnectionId: sourceId,
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
        sourceConnectionId: sourceId,
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

test(
  "supersede 验收（迁移 0016）：同 (job,candidate) 只留最新 active，旧行保留审核态，读取默认过滤",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-supersede-${marker}`,
      environment: "test",
      displayName: "Fixture Match Supersede",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, "sup-j1", 9);
      const cand1 = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: "sup-c1",
        displayName: "王**",
        summary: "示例公司-前端工程师",
      });
      const cand2 = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: "sup-c2",
        displayName: "赵**",
        summary: "示例公司-后端工程师",
      });
      const jobId2 = await seedJob(sql, sourceId, "sup-j2", 9);

      // ---- 场景 1：不同 rule_version（输入变化）→ 旧行 superseded、新行 active ----
      const m1 = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 74,
        band: "low",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      // 审核态保留验证：把旧行审核为 approved，再被新行 supersede 时 status 仍为 approved
      await updateMatchStatus(sql, { id: m1.id, status: "approved" });

      const m2 = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 80,
        band: "medium",
        ruleVersion: 2,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      assert.notEqual(m2.id, m1.id, "输入变化 → 新 rule_version → 新行");

      const after = await getMatchById(sql, m1.id);
      assert.equal(after.isSuperseded, true, "旧行标 superseded");
      assert.equal(after.status, "approved", "审核态保留：superseded 不覆盖 approved");
      assert.equal((await getMatchById(sql, m2.id)).isSuperseded, false, "新行 active");

      // ---- 场景 2：listMatches 默认排除 superseded；includeSuperseded 可见 ----
      const listDefault = await listMatches(sql, { jobId, pageSize: 100 });
      assert.equal(listDefault.total, 1, "默认只显示 active");
      assert.equal(listDefault.list[0].id, m2.id, "默认显示最新");
      const listAll = await listMatches(sql, { jobId, pageSize: 100, includeSuperseded: true });
      assert.equal(listAll.total, 2, "includeSuperseded 返回全部");
      // created_at desc 排序：最新的 active 在前，旧 superseded 在后
      assert.equal(listAll.list[0].id, m2.id, "active 最新在前");
      assert.equal(listAll.list[0].isSuperseded, false, "active 行投影 isSuperseded=false");
      assert.equal(listAll.list[1].isSuperseded, true, "旧行投影 isSuperseded 标记");

      // ---- 场景 3：status 过滤也不返回 superseded（布尔方案的回归） ----
      const pendingOnly = await listMatches(sql, { jobId, status: "approved", pageSize: 100 });
      assert.equal(pendingOnly.total, 0, "superseded 的 approved 不因 status=approved 返回");

      // ---- 场景 4：落地页已审核匹配读取排除 superseded ----
      const approvedForTouch = await findApprovedMatchForJobCandidate(sql, { jobId, candidateId: cand1 });
      assert.equal(approvedForTouch, null, "superseded 的 approved 不进入触达门禁");

      // ---- 场景 5：superseded 匹配不可再审（路由 409 语义） ----
      const m3 = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 82,
        band: "medium",
        ruleVersion: 3,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      // m2 现在被 m3 supersede（pending_review 状态、is_superseded=true）
      const reviewAgain = await updateMatchStatus(sql, { id: m2.id, status: "approved" });
      assert.equal(reviewAgain, null, "superseded 匹配不可审核");

      // ---- 场景 6：同 rule_version 幂等重跑不误伤（仍 1 条 active） ----
      const m3Again = await upsertMatch(sql, {
        jobId,
        candidateId: cand1,
        score: 82,
        band: "medium",
        ruleVersion: 3,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      assert.equal(m3Again.id, m3.id, "同 rule_version 冲突更新原行");
      const afterIdem = await listMatches(sql, { jobId, pageSize: 100 });
      assert.equal(afterIdem.total, 1, "幂等重跑不产生新 active");
      assert.equal(afterIdem.list[0].id, m3.id);

      // ---- 场景 7：supersede 只影响同 (job,candidate)，不误伤同 job 其他候选/同候选人其他 job ----
      const otherCand = await upsertMatch(sql, {
        jobId,
        candidateId: cand2,
        score: 70,
        band: "low",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      const otherJob = await upsertMatch(sql, {
        jobId: jobId2,
        candidateId: cand1,
        score: 71,
        band: "low",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      assert.equal((await getMatchById(sql, otherCand.id)).isSuperseded, false, "同 job 其他候选人不受影响");
      assert.equal((await getMatchById(sql, otherJob.id)).isSuperseded, false, "同候选人其他 job 不受影响");
      assert.equal((await getMatchById(sql, m3.id)).isSuperseded, false, "场景 7 写入不误伤既有 active");
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "候选人状态推导（迁移 0016）：仅 superseded 匹配 → 待匹配，active 匹配正常归类",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-match-cand-status-${marker}`,
      environment: "test",
      displayName: "Fixture Candidate Status",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      const jobId = await seedJob(sql, sourceId, "candst-j1", 9);

      // 候选人 A：仅 superseded 匹配 → 待匹配、matchCount 0
      const candA = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: "candst-a",
        displayName: "秦**",
        summary: "示例公司-运维工程师",
      });
      await sql`
        insert into candidate_profiles (candidate_id, current_title, experience_years, skills)
        values (${candA}, '高级运维工程师', 6, ${sql.json(["Linux"])})
      `;
      const mA = await upsertMatch(sql, {
        jobId,
        candidateId: candA,
        score: 74,
        band: "low",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      // 模拟外因（清理/旧行被取代后新行撤下）导致 A 全部匹配 superseded、无 active
      await sql`update matches set is_superseded = true where id = ${mA.id}`;

      // 候选人 B：active approved → 已审核
      const candB = await upsertCandidate(sql, {
        sourceConnectionId: sourceId,
        externalId: "candst-b",
        displayName: "周**",
        summary: "示例公司-测试工程师",
      });
      await sql`
        insert into candidate_profiles (candidate_id, current_title, experience_years, skills)
        values (${candB}, '高级测试工程师', 5, ${sql.json(["Selenium"])})
      `;
      const mB = await upsertMatch(sql, {
        jobId,
        candidateId: candB,
        score: 88,
        band: "high",
        ruleVersion: 1,
        status: "pending_review",
        scoreStatus: "llm_aggregated",
        supersedePrior: true,
      });
      await updateMatchStatus(sql, { id: mB.id, status: "approved" });

      const { list } = await listCandidates(sql, { pageSize: 100 });
      const a = list.find((c) => c.externalId === "candst-a");
      const b = list.find((c) => c.externalId === "candst-b");
      assert.equal(a.status, "待匹配", "仅 superseded 匹配 → 待匹配");
      assert.equal(a.matchCount, 0, "matchCount 不含 superseded");
      assert.equal(b.status, "已审核", "active approved → 已审核");
    } finally {
      // candidate_profiles 需在 candidates 前删
      await sql`delete from candidate_profiles where candidate_id in (
        select id from candidates where source_connection_id = ${sourceId})`;
      await cleanup(sql, sourceId);
    }
  },
);
