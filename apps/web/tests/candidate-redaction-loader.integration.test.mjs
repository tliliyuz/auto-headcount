import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { loadCandidateRedactedDetails } from "../lib/jobs/candidate-redaction-loader.mjs";
import {
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import {
  enqueueProjectionFilterTasks,
  processDueTasks,
} from "../lib/jobs/sync-scheduler.mjs";
import { encryptJsonPayload } from "../lib/security/payload-encryption.mjs";

const connectionString = process.env.DATABASE_URL;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

/**
 * seed 候选人 + 画像；`record` 非空时再写加密 raw_records（entity_type='candidate'）
 * 并回填 candidates.raw_record_id（与真实采集一致：详情合同回执整包加密落库）。
 */
async function seedCandidate(sql, { sourceId, externalId, displayName, profile, record }) {
  const [cand] = await sql`
    insert into candidates (source_connection_id, external_id, display_name, summary)
    values (${sourceId}, ${externalId}, ${displayName}, ${profile.summary ?? null})
    returning id
  `;
  await sql`
    insert into candidate_profiles (
      candidate_id, current_title, current_company, skills, experience_years, location,
      education, seniority, industry, expected_salary_min, expected_salary_max, activity_updated_at
    ) values (
      ${cand.id}, ${profile.currentTitle ?? null}, ${profile.currentCompany ?? null},
      ${sql.json(profile.skills ?? [])}, ${profile.experienceYears ?? null},
      ${profile.location ?? null}, ${profile.education ?? null}, ${profile.seniority ?? null},
      ${profile.industry ?? null}, ${profile.expectedSalaryMin ?? null},
      ${profile.expectedSalaryMax ?? null}, ${profile.activityUpdatedAt ?? null}
    )
  `;
  if (record) {
    const [runId] = await sql`
      insert into sync_runs (source_connection_id, sync_type, status, started_at)
      values (${sourceId}, 'browser_candidate_collect', 'succeeded', now())
      returning id
    `;
    const encrypted = await encryptJsonPayload(record, encryption);
    const [raw] = await sql`
      insert into raw_records (
        sync_run_id, source_connection_id, entity_type, external_id, schema_version,
        payload_ciphertext, payload_nonce, key_version, payload_hash, processing_status, captured_at
      ) values (
        ${runId.id}, ${sourceId}, 'candidate', ${externalId}, 'liebide-candidate-detail-v1',
        ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.keyVersion},
        ${encrypted.payloadHash}, 'normalized', now()
      )
      returning id
    `;
    await sql`update candidates set raw_record_id = ${raw.id} where id = ${cand.id}`;
  }
  return cand.id;
}

/** seed 可操作沉睡职位 + job_requirements（skills 命中才硬过滤通过）。 */
async function seedJob(sql, sourceId, syncRunId, externalId, ageDays) {
  const { jobId } = await persistUnderServedJob(sql, {
    sourceId,
    syncRunId,
    rawPayload: { job_id: externalId },
    job: {
      externalId,
      title: `CRL Job ${externalId}`,
      companyName: "Fixture Co",
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
    },
    encryption,
    operabilityStatus: "actionable",
  });
  await sql`
    insert into job_requirements (job_id, skills, seniority, education, salary_min, salary_max, constraints)
    values (${jobId}, ${sql.json(["Node.js", "PostgreSQL"])}, '高级', '本科', 30, 60,
            ${sql.json({ min_experience_years: 5 })}) on conflict (job_id) do nothing
  `;
  return jobId;
}

/** 清理（FK 顺序）：filter → 投影 → 候选人/职位 → raw_records/sync_runs → 源/任务/审计。 */
async function cleanup(sql, { sourceId, candIds, jobIds, taskIds }) {
  if (sourceId) {
    if (jobIds?.length) {
      await sql`
        delete from match_filter_results
        where job_projection_id in (select id from job_match_projections where job_id = any(${jobIds}))
           or candidate_projection_id in (select id from candidate_match_projections where candidate_id = any(${candIds ?? []}))
      `;
      await sql`delete from job_match_projections where job_id = any(${jobIds})`;
    }
    if (candIds?.length) {
      await sql`delete from candidate_match_projections where candidate_id = any(${candIds})`;
      await sql`delete from candidate_profiles where candidate_id = any(${candIds})`;
      await sql`delete from candidates where id = any(${candIds})`;
      await sql`delete from job_requirements where job_id in (select id from jobs where source_connection_id = ${sourceId})`;
    }
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  const autoMatch = await sql`select id from source_connections where provider = 'auto-match'`;
  for (const row of autoMatch) {
    await sql`delete from sync_runs where source_connection_id = ${row.id}`;
    await sql`delete from source_connections where id = ${row.id}`;
  }
  if (taskIds?.length) {
    await sql`delete from async_tasks where id = any(${taskIds})`;
    await sql.begin(async (t) => {
      await t`set local app.audit_retention = 'on'`;
      await t`delete from audit_logs where action = 'sync.run' and request_id = any(${taskIds})`;
    });
  }
  await sql.end();
}

test(
  "loadCandidateRedactedDetails：组装脱敏 career_history（公司名泛化）+ 无详情来源跳过",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-crl-${marker}`,
      environment: "test",
      displayName: "Fixture Candidate Redaction Loader",
    };
    let sourceId;
    const candIds = [];
    try {
      sourceId = await getOrCreateSourceConnection(sql, source);

      // A：有 raw_record + workExperiences（含一个空 title 条目，应被跳过）
      const aId = await seedCandidate(sql, {
        sourceId,
        externalId: `crl-a-${marker}`,
        displayName: "张**",
        profile: { currentTitle: "高级工程师", experienceYears: 6, location: "上海", education: "本科", seniority: "高级" },
        record: {
          candidateId: `crl-a-${marker}`,
          realName: "张**",
          title: "高级工程师",
          workExperiences: [
            { company: "字节跳动", title: "资深开发" },
            { company: "美团", title: "高级工程师" },
            { company: "某真实公司", title: "   " },
          ],
        },
      });
      candIds.push(aId);
      // B：无 raw_record → 不进 Map
      const bId = await seedCandidate(sql, {
        sourceId,
        externalId: `crl-b-${marker}`,
        displayName: "李**",
        profile: { currentTitle: "工程师", experienceYears: 3, location: "北京" },
      });
      candIds.push(bId);
      // C：有 raw_record 但载荷无 workExperiences 键 → 不进 Map
      const cId = await seedCandidate(sql, {
        sourceId,
        externalId: `crl-c-${marker}`,
        displayName: "王**",
        profile: { currentTitle: "产品经理", experienceYears: 4, location: "深圳" },
        record: { candidateId: `crl-c-${marker}`, realName: "王**", title: "产品经理" },
      });
      candIds.push(cId);

      const map = await loadCandidateRedactedDetails(sql, { encryption });

      assert.equal(map.has(aId), true, "有 raw_record 且有工作经历的候选人应进 Map");
      assert.deepEqual(
        map.get(aId),
        { career_history: ["某公司 · 资深开发", "某公司 · 高级工程师"], project_highlights: [] },
        "公司名泛化 + 排序去重 + 空 title 跳过",
      );
      for (const item of map.get(aId).career_history) {
        assert.ok(
          !item.includes("字节跳动") && !item.includes("美团") && !item.includes("某真实公司"),
          `公司名必须泛化，实际含真实公司名：${item}`,
        );
        assert.ok(item.length <= 1000, "单条 career_history 不得超过 1000 字符");
      }
      assert.ok(map.get(aId).career_history.length <= 30, "career_history 不得超过 30 条");

      assert.equal(map.has(bId), false, "无 raw_record 的候选人不应进 Map");
      assert.equal(map.has(cId), false, "载荷无 workExperiences 的候选人不应进 Map");
    } finally {
      await cleanup(sql, { sourceId, candIds });
    }
  },
);

test(
  "match_projection_filter 调度路径：真实候选人（raw_records 工作经历）收敛为 (job, candidate) 匹配池",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-crl2-${marker}`,
      environment: "test",
      displayName: "Fixture Scheduler Redaction",
    };
    const now = new Date();
    let sourceId;
    const jobIds = [];
    const candIds = [];
    const taskIds = [];
    try {
      sourceId = await getOrCreateSourceConnection(sql, source);

      // seed 2 个可操作沉睡职位 + job_requirements
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      for (const [i, ext] of [`crl2-j1-${marker}`, `crl2-j2-${marker}`].entries()) {
        jobIds.push(await seedJob(sql, sourceId, runId, ext, 9 + i * 5));
      }
      await finishSyncRun(sql, runId, { processed: 2, persisted: 2 });

      // seed 1 候选人：画像全命中职位硬过滤 + raw_record 工作经历（供 loader 组装 career_history）
      const candId = await seedCandidate(sql, {
        sourceId,
        externalId: `crl2-c-${marker}`,
        displayName: "张**",
        profile: {
          currentTitle: "高级工程师",
          currentCompany: "高德",
          skills: ["Node.js", "PostgreSQL", "React"],
          experienceYears: 7,
          location: "上海",
          education: "硕士",
          seniority: "高级",
          industry: "互联网",
          expectedSalaryMin: 35,
          expectedSalaryMax: 55,
        },
        record: {
          candidateId: `crl2-c-${marker}`,
          realName: "张**",
          title: "高级工程师",
          company: "高德",
          workExperiences: [
            { company: "高德地图", title: "无线开发专家" },
            { company: "美团", title: "大前端工程师" },
          ],
        },
      });
      candIds.push(candId);

      const enqueued = await enqueueProjectionFilterTasks(sql, { now, intervalMs: SIX_HOURS_MS });
      assert.equal(enqueued.projectionEnqueued, true);
      taskIds.push(enqueued.taskId);

      const env = {
        APP_ENV: "test",
        APP_ENCRYPTION_KEY: encryption.key,
        APP_ENCRYPTION_KEY_VERSION: encryption.keyVersion,
      };
      const counts = await processDueTasks(sql, { env, now });
      assert.equal(counts.succeeded, 1, "投影任务应 succeeded");
      const [task] = await sql`
        select status from async_tasks where id = ${enqueued.taskId}
      `;
      assert.equal(task.status, "succeeded");

      // 真实候选人（有 raw_record 工作经历）应产出消费态候选投影
      const [candProj] = await sql`
        select count(*)::int as n from candidate_match_projections
        where candidate_id = ${candId} and status = 'consumable'
      `;
      assert.equal(candProj.n, 1, "真实候选人应落 1 条消费态候选投影");

      const [jobProj] = await sql`
        select count(*)::int as n from job_match_projections
        where job_id = any(${jobIds}) and status = 'consumable'
      `;
      assert.equal(jobProj.n, 2, "两个职位都应有消费态职位投影");

      const [filter] = await sql`
        select count(*)::int as n,
               count(*) filter (where passed)::int as passed
        from match_filter_results
        where job_projection_id in (select id from job_match_projections where job_id = any(${jobIds}))
      `;
      assert.ok(filter.n >= 1, "应产出硬过滤结果");
      assert.ok(filter.passed >= 1, "应存在硬过滤通过的行");

      // 审计白名单键：candidatesProjected / piiRejected / jobsProjected
      const [audit] = await sql`
        select metadata from audit_logs
        where action = 'sync.run' and request_id = ${enqueued.taskId}
      `;
      assert.ok(audit, "调度应写 sync.run 审计");
      assert.equal(audit.metadata.candidatesProjected, 1, "有详情来源的真实候选人应被投影");
      assert.equal(audit.metadata.piiRejected, 0, "无详情来源候选人才计 piiRejected");
      assert.equal(audit.metadata.jobsProjected, 2);
    } finally {
      await cleanup(sql, { sourceId, candIds, jobIds, taskIds });
    }
  },
);
