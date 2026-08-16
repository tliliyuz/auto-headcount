import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { runJobRequirementsSync } from "../lib/jobs/job-requirements-sync.mjs";
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

function fixtureJob(externalId) {
  return {
    externalId,
    title: `Job ${externalId}`,
    companyName: "Fixture Company",
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays: 9,
    lastRecommendationAt: null,
    category: "Engineering",
    city: "Shanghai",
    salaryMin: 20,
    salaryMax: 30,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: { activeStatus: "provider_filter" },
  };
}

/** seed：active 职位；有 JD 的写 job_description，缺省保持 null。 */
async function seedJobs(sql, sourceId, specs) {
  const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
  for (const spec of specs) {
    await persistUnderServedJob(sql, {
      sourceId,
      syncRunId: runId,
      rawPayload: { job_id: spec.externalId },
      job: fixtureJob(spec.externalId),
      encryption,
      operabilityStatus: "actionable",
    });
    if (spec.jobDescription !== undefined) {
      await sql`
        update jobs set job_description = ${spec.jobDescription}
        where source_connection_id = ${sourceId} and external_id = ${spec.externalId}
      `;
    }
  }
  await finishSyncRun(sql, runId, { processed: specs.length, persisted: specs.length });
}

async function cleanup(sql, sourceId) {
  if (sourceId) {
    // job_requirements 对 jobs 是 ON DELETE restrict：先删 requirements 再删 jobs。
    await sql`
      delete from job_requirements
      where job_id in (select id from jobs where source_connection_id = ${sourceId})
    `;
    await sql`delete from jobs where source_connection_id = ${sourceId}`;
    await sql`delete from raw_records where source_connection_id = ${sourceId}`;
    await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
    await sql`delete from source_connections where id = ${sourceId}`;
  }
  await sql.end();
}

const RICH_JD =
  "统招本科及以上学历，精通 Java、Spring、MySQL，熟悉分布式，3年以上经验，薪资20K-35K";

test(
  "job_requirements_extract 同步：有 JD 职位落库，空 JD 落全空行，无 JD 职位跳过",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-req-${marker}`,
      environment: "test",
      displayName: "Fixture Job Requirements Sync",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [
        { externalId: "j1", jobDescription: RICH_JD },
        { externalId: "j2", jobDescription: "" },
        { externalId: "j3" }, // 无 JD → 不提取
      ]);

      const outcome = await runJobRequirementsSync({ sql, source });
      assert.equal(outcome.status, "succeeded");
      assert.equal(outcome.stats.jobsQueried, 2);
      assert.equal(outcome.stats.written, 2);
      assert.equal(outcome.stats.failed, 0);

      const rows = await sql`
        select j.external_id, r.skills, r.education, r.salary_min, r.salary_max,
               r.constraints, r.seniority
        from job_requirements r
        join jobs j on j.id = r.job_id
        where j.source_connection_id = ${sourceId}
        order by j.external_id
      `;
      const map = new Map(rows.map((r) => [r.external_id, r]));

      // j1：富 JD → 解析出技能/学历/年限/薪资
      assert.ok(map.has("j1"));
      assert.deepEqual(map.get("j1").skills.sort(), ["Java", "MySQL", "Spring", "分布式"]);
      assert.equal(map.get("j1").education, "本科");
      assert.equal(map.get("j1").constraints.min_experience_years, 3);
      assert.equal(map.get("j1").salary_min, 20000);
      assert.equal(map.get("j1").salary_max, 35000);
      // constraints 为对象且含消费端 5 键
      assert.deepEqual(Object.keys(map.get("j1").constraints).sort(), [
        "business_context",
        "min_experience_years",
        "preferred_skills",
        "required_certificates",
        "salary_hard_constraint",
      ]);

      // j2：空 JD → 全空行（避免每周期重扫）
      assert.ok(map.has("j2"));
      assert.deepEqual(map.get("j2").skills, []);
      assert.equal(map.get("j2").education, null);
      assert.equal(map.get("j2").salary_min, null);

      // j3：无 JD → 无 requirements 行
      assert.ok(!map.has("j3"));
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);

test(
  "job_requirements_extract 同步：幂等——再跑 jobsQueried=0、行不变、sync_runs 两条",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const source = {
      provider: `fixture-req-${marker}`,
      environment: "test",
      displayName: "Fixture Job Requirements Idempotency",
    };
    let sourceId;

    try {
      sourceId = await getOrCreateSourceConnection(sql, source);
      await seedJobs(sql, sourceId, [{ externalId: "j1", jobDescription: RICH_JD }]);

      const first = await runJobRequirementsSync({ sql, source });
      assert.equal(first.status, "succeeded");
      assert.equal(first.stats.jobsQueried, 1);
      assert.equal(first.stats.written, 1);

      const second = await runJobRequirementsSync({ sql, source });
      assert.equal(second.status, "succeeded");
      assert.equal(second.stats.jobsQueried, 0, "已填职位的行不再选择");

      const [count] = await sql`
        select count(*)::int as count
        from job_requirements r
        join jobs j on j.id = r.job_id
        where j.source_connection_id = ${sourceId}
      `;
      assert.equal(count.count, 1, "行数不变");

      const runs = await sql`
        select sync_type, status from sync_runs
        where source_connection_id = ${sourceId} and sync_type = 'job_requirements_extract'
        order by created_at
      `;
      assert.equal(runs.length, 2, "每次运行新增一条 sync_run");
      assert.ok(runs.every((r) => r.status === "succeeded"));
    } finally {
      await cleanup(sql, sourceId);
    }
  },
);
