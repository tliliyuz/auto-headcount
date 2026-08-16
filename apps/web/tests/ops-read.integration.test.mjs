import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import {
  failSyncRun,
  finishSyncRun,
  getOrCreateSourceConnection,
  persistUnderServedJob,
  startSyncRun,
} from "../lib/jobs/job-sync-repository.mjs";
import {
  getJobById,
  listUnderServedJobs,
} from "../lib/jobs/job-read-repository.mjs";
import {
  listSources,
  listSyncRuns,
} from "../lib/sources/source-read-repository.mjs";
import { getCandidateById, listCandidates } from "../lib/jobs/candidate-read-repository.mjs";
import { encryptJsonPayload } from "../lib/security/payload-encryption.mjs";

const connectionString = process.env.DATABASE_URL;
const encryption = {
  key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  keyVersion: "test-v1",
};

function fixtureJob(externalId, { title, category, city, ageDays }) {
  return {
    externalId,
    title,
    companyName: `Fixture Company ${title}`,
    ownerExternalId: "fixture-owner",
    ownerName: "Fixture Owner",
    ageDays,
    lastRecommendationAt: null,
    category,
    city,
    salaryMin: 10,
    salaryMax: 20,
    portalUrl: `https://portal.invalid/jobs/${externalId}`,
    sourceCreatedAt: null,
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

test(
  "业务只读端点：沉睡职位过滤/分页/投影 + 数据源与同步批次查询",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceIdA;
    let sourceIdB;
    let pageSource;

    try {
      // Source A：成功同步，含边界与非合格职位
      sourceIdA = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-a`,
        environment: "test",
        displayName: "Fixture Source A",
      });
      const runA = await startSyncRun(sql, sourceIdA, "under_served_jobs");
      const jobFixtures = [
        fixtureJob("a-1", { title: "Alpha Engineer", category: "Engineering", city: "Shanghai", ageDays: 7 }),
        fixtureJob("a-2", { title: "Beta Analyst", category: "Data", city: "Beijing", ageDays: 30 }),
        fixtureJob("a-3", { title: "Gamma Engineer", category: "Engineering", city: "Shenzhen", ageDays: 12 }),
        fixtureJob("a-4", { title: "Delta Analyst", category: "Data", city: "Hangzhou", ageDays: 15 }),
        fixtureJob("a-5", { title: "Epsilon Ops", category: "Engineering", city: "Guangzhou", ageDays: 6 }),
        fixtureJob("a-6", { title: "Zeta Architect", category: "Data", city: "Chengdu", ageDays: 31 }),
      ];
      for (const job of jobFixtures) {
        await persistUnderServedJob(sql, {
          sourceId: sourceIdA,
          syncRunId: runA,
          rawPayload: { job_id: job.externalId },
          job,
          encryption,
        });
      }
      await finishSyncRun(sql, runA, { processed: 6, persisted: 6 });

      // 用真实列使两条合格记录出局：非零有效推荐 + 失效状态
      await sql`
        update jobs set valid_recommendation_count = 3
        where source_connection_id = ${sourceIdA} and external_id = 'a-3'
      `;
      await sql`
        update jobs set status = 'inactive'
        where source_connection_id = ${sourceIdA} and external_id = 'a-4'
      `;

      // Source B：失败同步
      sourceIdB = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-b`,
        environment: "test",
        displayName: "Fixture Source B",
      });
      const runB = await startSyncRun(sql, sourceIdB, "under_served_jobs");
      await failSyncRun(sql, runB, "RATE_LIMITED", { processed: 0 });

      // 1) 沉睡规则边界（夹具范围断言，容忍共享 DB 并行数据）：
      //    7/30 天含边界入选，6/31 天、失效、非零推荐出局
      // 夹具可能被真实数据（按沉睡天数排序）挤出前 N 页：查询页大小放宽到足以包含夹具
      const all = await listUnderServedJobs(sql, { pageSize: 5000 });
      const allIds = new Set(all.list.map((job) => job.externalId));
      assert.equal(allIds.has("a-1"), true);
      assert.equal(allIds.has("a-2"), true);
      for (const excluded of ["a-3", "a-4", "a-5", "a-6"]) {
        assert.equal(allIds.has(excluded), false, `${excluded} 不应入选`);
      }

      // 2) category 与 q 过滤（夹具范围）
      const engineering = await listUnderServedJobs(sql, { category: "Engineering", pageSize: 5000 });
      const engIds = engineering.list.map((job) => job.externalId);
      assert.equal(engIds.includes("a-1"), true);
      assert.equal(engIds.includes("a-3"), false);
      // q 过滤：夹具来源限定（共享 DB 可能有真实职位命中同一关键词，不能用全库唯一断言）
      const byQuery = await listUnderServedJobs(sql, { q: "beta", pageSize: 5000 });
      assert.equal(byQuery.list.length >= 1, true);
      const byQueryFixture = byQuery.list.filter(
        (job) => job.sourceConnectionId === sourceIdA,
      );
      assert.equal(byQueryFixture.length, 1, "夹具来源仅 a-2 命中关键词 beta");
      assert.equal(byQueryFixture[0].externalId, "a-2");
      const byCity = await listUnderServedJobs(sql, { q: "beijing", pageSize: 5000 });
      assert.equal(byCity.list.length >= 1, true);
      const byCityFixture = byCity.list.filter(
        (job) => job.sourceConnectionId === sourceIdA,
      );
      assert.equal(byCityFixture.length, 1, "夹具来源仅 a-2 命中关键词 beijing");
      assert.equal(byCityFixture[0].externalId, "a-2");

      // 3) 分页一致性：独立夹具源 + q 过滤隔离（不依赖共享库存量数据）。分页查询面向
      //    全库，此前依赖真实 scheduler 的存量职位填充页数、也受其并发写入扰动；
      //    现在用 q:"Paged" 把断言窗口收敛到本测试自有的 5 条夹具，页间不重叠可确定断言。
      pageSource = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-page`,
        environment: "test",
        displayName: "Fixture Page Source",
      });
      const pageRun = await startSyncRun(sql, pageSource, "under_served_jobs");
      const pagedFixtures = [
        fixtureJob("p-1", { title: "Paged Alpha", category: "Data", city: "Hangzhou", ageDays: 8 }),
        fixtureJob("p-2", { title: "Paged Beta", category: "Data", city: "Ningbo", ageDays: 9 }),
        fixtureJob("p-3", { title: "Paged Gamma", category: "Data", city: "Wenzhou", ageDays: 10 }),
        fixtureJob("p-4", { title: "Paged Delta", category: "Data", city: "Shaoxing", ageDays: 11 }),
        fixtureJob("p-5", { title: "Paged Epsilon", category: "Data", city: "Jiaxing", ageDays: 12 }),
      ];
      for (const job of pagedFixtures) {
        await persistUnderServedJob(sql, {
          sourceId: pageSource,
          syncRunId: pageRun,
          rawPayload: { job_id: job.externalId },
          job,
          encryption,
        });
      }
      await finishSyncRun(sql, pageRun, { processed: 5, persisted: 5 });

      // 排序：age_days 降序 → created_at 降序 → id 降序（id 为唯一键，次序确定）。
      // age 8~12 共 5 条，页大小 2 → 第 1/2 页各 2 条、第 3 页余 1 条（p-1）。
      const pageOne = await listUnderServedJobs(sql, { q: "Paged", page: 1, pageSize: 2 });
      assert.equal(pageOne.total, 5, "q:Paged 只命中本测试的分页夹具");
      assert.equal(pageOne.totalPages, 3);
      assert.equal(pageOne.list.length, 2);
      const pageOneIds = new Set(pageOne.list.map((job) => job.externalId));
      const pageTwo = await listUnderServedJobs(sql, { q: "Paged", page: 2, pageSize: 2 });
      assert.equal(
        pageTwo.list.some((job) => pageOneIds.has(job.externalId)),
        false,
        "第二页不应与第一页重叠",
      );
      assert.equal(pageTwo.list.length, 2);
      const pageThree = await listUnderServedJobs(sql, { q: "Paged", page: 3, pageSize: 2 });
      assert.equal(pageThree.list.length, 1, "第三页余 1 条");
      assert.equal(pageThree.list[0].externalId, "p-1");

      // 4) 字段投影：camelCase、含内部字段、绝不出现 payload_* 或 cursor
      const a1 = all.list.find((job) => job.externalId === "a-1");
      assert.equal(a1.ageDays, 7);
      assert.equal(a1.recommendationCount, 0);
      assert.equal(a1.status, "active");
      assert.equal(typeof a1.companyName, "string");
      assert.equal(typeof a1.detailedLocation === "string" || a1.detailedLocation === null, true);
      assert.equal("payload_ciphertext" in a1, false);
      assert.equal(Object.keys(a1).some((key) => key.startsWith("payload_")), false);

      // 5) listSources：连接 + 最新同步摘要（夹具范围）
      const sources = await listSources(sql, { pageSize: 100 });
      assert.equal(sources.total >= 2, true);
      const sourceMap = new Map(sources.list.map((s) => [s.provider, s]));
      const sourceA = sourceMap.get(`fixture-${marker}-a`);
      const sourceB = sourceMap.get(`fixture-${marker}-b`);
      assert.equal(sourceA.displayName, "Fixture Source A");
      assert.equal(sourceA.lastRunStatus, "succeeded");
      assert.equal(sourceA.lastRunStats.persisted, 6);
      assert.equal(sourceB.lastRunStatus, "failed");
      assert.equal(sourceB.lastRunErrorCode, "RATE_LIMITED");

      // 6) listSyncRuns：join 字段与 status 过滤（夹具范围）
      const syncRuns = await listSyncRuns(sql, { pageSize: 100 });
      assert.equal(syncRuns.total >= 2, true);
      const runBView = syncRuns.list.find(
        (run) => run.sourceDisplayName === "Fixture Source B",
      );
      assert.equal(runBView.status, "failed");
      assert.equal(runBView.errorCode, "RATE_LIMITED");
      const succeeded = await listSyncRuns(sql, { status: "succeeded", pageSize: 100 });
      assert.equal(succeeded.list.every((run) => run.status === "succeeded"), true);
      assert.equal(
        succeeded.list.some((run) => run.sourceDisplayName === "Fixture Source A"),
        true,
      );
      assert.equal("cursor" in runBView, false);
    } finally {
      for (const sourceId of [sourceIdA, sourceIdB, pageSource]) {
        if (sourceId) {
          await sql`delete from jobs where source_connection_id = ${sourceId}`;
          await sql`delete from raw_records where source_connection_id = ${sourceId}`;
          await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
          await sql`delete from source_connections where id = ${sourceId}`;
        }
      }
      await sql.end();
    }
  },
);

test(
  "valid_recommendation_count：真值 0 纳入沉睡，重同步不覆盖既有计数",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-n6`,
        environment: "test",
        displayName: "Fixture N6 Source",
      });

      // 首次同步写入两条零推荐职位（NULL）
      const run1 = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: run1,
        rawPayload: { job_id: "n6-zero" },
        job: fixtureJob("n6-zero", { title: "N6 Zero", category: "Data", city: "Hangzhou", ageDays: 9 }),
        encryption,
      });
      await finishSyncRun(sql, run1, { processed: 1, persisted: 1 });

      // 推荐工作流写入真值 0（而非 NULL）
      await sql`
        update jobs set valid_recommendation_count = 0
        where source_connection_id = ${sourceId} and external_id = 'n6-zero'
      `;

      // 真值 0 仍应纳入沉睡列表（q 按标题 "N6 Zero" 命中）
      const afterZero = await listUnderServedJobs(sql, { q: "N6", pageSize: 100 });
      assert.equal(afterZero.list.length, 1, "valid_recommendation_count=0 应纳入沉睡");
      assert.equal(afterZero.list[0].recommendationCount, 0);

      // 重同步：upsert 不得用 NULL 覆盖既有计数
      const run2 = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: run2,
        rawPayload: { job_id: "n6-zero" },
        job: fixtureJob("n6-zero", { title: "N6 Zero", category: "Data", city: "Hangzhou", ageDays: 9 }),
        encryption,
      });
      await finishSyncRun(sql, run2, { processed: 1, persisted: 1 });

      const [row] = await sql`
        select valid_recommendation_count from jobs
        where source_connection_id = ${sourceId} and external_id = 'n6-zero'
      `;
      assert.equal(row.valid_recommendation_count, 0, "重同步不得用 NULL 覆盖推荐计数");
      const afterResync = await listUnderServedJobs(sql, { q: "N6", pageSize: 100 });
      assert.equal(afterResync.list.length, 1, "重同步后真值 0 仍应纳入沉睡");
    } finally {
      if (sourceId) {
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "getJobById：返回含 jobDescription 的内部详情投影，未知 id 返回 undefined",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-detail`,
        environment: "test",
        displayName: "Fixture Detail Source",
      });
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: runId,
        rawPayload: { job_id: "d-1" },
        job: fixtureJob("d-1", { title: "Detail Engineer", category: "Engineering", city: "Shanghai", ageDays: 11 }),
        encryption,
      });
      await sql`
        update jobs set job_description = '完整 JD 文本' , detailed_location = '上海·张江'
        where source_connection_id = ${sourceId} and external_id = 'd-1'
      `;
      await finishSyncRun(sql, runId, { processed: 1, persisted: 1 });

      const [saved] = await sql`
        select id from jobs
        where source_connection_id = ${sourceId} and external_id = 'd-1'
      `;

      const detail = await getJobById(sql, saved.id);
      assert.equal(detail.externalId, "d-1");
      assert.equal(detail.title, "Detail Engineer");
      assert.equal(detail.jobDescription, "完整 JD 文本");
      assert.equal(detail.detailedLocation, "上海·张江");
      assert.equal(typeof detail.companyName, "string");
      assert.equal("portalUrl" in detail, false, "详情投影不得含 portal_url");
      assert.equal(Object.keys(detail).some((k) => k.startsWith("payload_")), false);

      const unknown = await getJobById(sql, randomUUID());
      assert.equal(unknown, undefined, "未知 id 返回 undefined → 路由映射 404");
    } finally {
      if (sourceId) {
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "同 JD 多城市批量挂岗去重：列表返回代表 + 城市并集，空 JD 职位不合并",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-${marker}-dedup`,
        environment: "test",
        displayName: "Fixture Dedup Source",
      });
      const runId = await startSyncRun(sql, sourceId, "under_served_jobs");
      const variants = [
        fixtureJob("dd-1", { title: "Same JD Engineer", category: "Engineering", city: "Beijing", ageDays: 12 }),
        fixtureJob("dd-2", { title: "Same JD Engineer", category: "Engineering", city: "Guangzhou", ageDays: 12 }),
        fixtureJob("dd-3", { title: "Same JD Engineer", category: "Engineering", city: "Shanghai", ageDays: 12 }),
      ];
      for (const job of variants) {
        await persistUnderServedJob(sql, { sourceId, syncRunId: runId, rawPayload: { job_id: job.externalId }, job, encryption });
      }
      // 同一 JD 文本 → 同一 jdHash → 三城合并为一组
      await sql`
        update jobs set job_description = '同 JD 模板完整描述：负责数据平台建设'
        where source_connection_id = ${sourceId} and external_id in ('dd-1', 'dd-2', 'dd-3')
      `;
      // 空 JD 职位（jdHash null，不入组）
      await persistUnderServedJob(sql, {
        sourceId,
        syncRunId: runId,
        rawPayload: { job_id: "dd-0" },
        job: fixtureJob("dd-0", { title: "Lone Job", category: "Engineering", city: "Shenzhen", ageDays: 20 }),
        encryption,
      });
      await finishSyncRun(sql, runId, { processed: 4, persisted: 4 });

      const list = await listUnderServedJobs(sql, { q: "Same JD Engineer", pageSize: 100 });
      assert.equal(list.list.length, 1, "同 JD 三城应合并为一个代表");
      assert.equal(list.list[0].title, "Same JD Engineer");
      assert.deepEqual(list.list[0].cities, ["Beijing", "Guangzhou", "Shanghai"], "代表 cities 为城市并集（字母序）");

      // 城市检索命中组内任意城市 → 代表返回
      const byVariantCity = await listUnderServedJobs(sql, { q: "guangzhou", pageSize: 100 });
      assert.equal(
        byVariantCity.list.some((j) => j.title === "Same JD Engineer"),
        true,
        "检索组内城市应命中代表职位",
      );

      // 空 JD 职位不合并、单独出现，cities 空数组（前端回退 city）
      const lone = await listUnderServedJobs(sql, { q: "Lone Job", pageSize: 100 });
      assert.equal(lone.list.length, 1);
      assert.deepEqual(lone.list[0].cities, []);

      // 详情：任一城市变体的 id 都返回组内城市并集
      const [variantRow] = await sql`
        select id from jobs where source_connection_id = ${sourceId} and external_id = 'dd-3'
      `;
      const detail = await getJobById(sql, variantRow.id);
      assert.deepEqual(detail.cities, ["Beijing", "Guangzhou", "Shanghai"], "详情返回城市并集");
    } finally {
      if (sourceId) {
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "listSyncRuns 默认排除详情采集 sync_run（browser_*_collect），周期同步不受影响",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-sync-filter-${marker}`,
        environment: "test",
        status: "active",
        displayName: "Sync Filter Source",
      });
      const periodic = await startSyncRun(sql, sourceId, "under_served_jobs");
      const detail = await startSyncRun(sql, sourceId, "browser_candidate_collect");

      const filtered = await listSyncRuns(sql, { pageSize: 100 });
      assert.equal(
        filtered.list.some((run) => run.id === detail),
        false,
        "默认排除 browser_candidate_collect 详情采集 sync_run",
      );
      assert.equal(
        filtered.list.some((run) => run.id === periodic),
        true,
        "under_served_jobs 周期同步应保留",
      );

      const all = await listSyncRuns(sql, { pageSize: 100, excludeBrowserDetail: false });
      assert.equal(
        all.list.some((run) => run.id === detail),
        true,
        "excludeBrowserDetail:false 时详情采集 sync_run 应返回",
      );
    } finally {
      if (sourceId) {
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "listCandidates：画像白名单、匹配状态推导、搜索与空画像夹具排除",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-cand-read-${marker}`,
        environment: "test",
        status: "active",
        displayName: "Cand Read Source",
      });
      const [job] = await sql`
        insert into jobs (source_connection_id, external_id, mapping_version, title, company_name, category, city, status, days_without_recommendation, eligibility_evidence, portal_url)
        values (${sourceId}, ${`cand-read-job-${marker}`}, 'test', '数据工程师', '虚构科技', '信息技术', '北京', 'active', 10, ${sql.json({ activeStatus: "provider_filter", zeroRecommendations: "provider_filter", age: "days_without_rec" })}, ${`https://portal.invalid/jobs/cand-read-${marker}`})
        returning id
      `;

      async function seedCandidate({ externalId, name, title, company, city, exp, edu, school, major, seniority }) {
        const [c] = await sql`
          insert into candidates (source_connection_id, external_id, display_name)
          values (${sourceId}, ${externalId}, ${name})
          returning id
        `;
        await sql`
          insert into candidate_profiles (candidate_id, current_title, current_company, location, experience_years, education, school, major, seniority)
          values (${c.id}, ${title}, ${company}, ${city}, ${exp}, ${edu}, ${school}, ${major}, ${seniority})
        `;
        return c.id;
      }

      const candMatched = await seedCandidate({ externalId: `cand-a-${marker}`, name: "示例甲", title: "数据工程师", company: "虚构科技", city: "北京", exp: 8, edu: "硕士", school: "虚构大学", major: "计算机", seniority: "高级" });
      await seedCandidate({ externalId: `cand-b-${marker}`, name: "示例乙", title: "算法工程师", company: "虚构数据", city: "上海", exp: 6, edu: "本科", school: null, major: null, seniority: "中级" });
      const candReviewed = await seedCandidate({ externalId: `cand-c-${marker}`, name: "示例丙", title: "后端工程师", company: "虚构云", city: "深圳", exp: 10, edu: "本科", school: "虚构理工", major: "软件工程", seniority: "资深" });

      await sql`
        insert into matches (job_id, candidate_id, score, band, status, rule_version)
        values (${job.id}, ${candMatched}, 88, 'high', 'generated', 1)
      `;
      await sql`
        insert into matches (job_id, candidate_id, score, band, status, rule_version)
        values (${job.id}, ${candReviewed}, 92, 'high', 'approved', 1)
      `;

      // 空画像夹具（落地页预览产生）应被排除
      const [preview] = await sql`
        insert into candidates (source_connection_id, external_id, display_name)
        values (${sourceId}, ${`preview-fixture-${marker}`}, '预览夹具')
        returning id
      `;
      await sql`insert into candidate_profiles (candidate_id) values (${preview.id})`;

      const all = await listCandidates(sql, { pageSize: 100 });
      const byExt = (ext) => all.list.find((r) => r.externalId === ext);
      assert.equal(all.list.some((r) => r.externalId === `preview-fixture-${marker}`), false, "空画像夹具排除");
      assert.equal(byExt(`cand-a-${marker}`).status, "已匹配");
      assert.equal(byExt(`cand-b-${marker}`).status, "待匹配");
      assert.equal(byExt(`cand-c-${marker}`).status, "已审核");
      assert.equal(byExt(`cand-a-${marker}`).name, "示例甲");
      assert.equal(byExt(`cand-a-${marker}`).title, "数据工程师");
      assert.equal(byExt(`cand-a-${marker}`).school, "虚构大学");
      assert.equal(byExt(`cand-b-${marker}`).major, null);

      const searched = await listCandidates(sql, { q: "虚构理工", pageSize: 100 });
      assert.equal(searched.list.length, 1);
      assert.equal(searched.list[0].externalId, `cand-c-${marker}`);

      const reviewed = await listCandidates(sql, { status: "已审核", pageSize: 100 });
      assert.equal(reviewed.list.length, 1);
      assert.equal(reviewed.list[0].externalId, `cand-c-${marker}`);
    } finally {
      if (sourceId) {
        await sql`delete from matches where candidate_id in (select id from candidates where source_connection_id = ${sourceId})`;
        await sql`delete from jobs where source_connection_id = ${sourceId}`;
        await sql`delete from candidate_profiles where candidate_id in (select id from candidates where source_connection_id = ${sourceId})`;
        await sql`delete from candidates where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);

test(
  "getCandidateById：从 raw_records 加密载荷解密工作经历，未知 id 返回 undefined",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let sourceId;
    let candidateId;
    try {
      sourceId = await getOrCreateSourceConnection(sql, {
        provider: `fixture-cand-detail-${marker}`,
        environment: "test",
        status: "active",
        displayName: "Cand Detail Source",
      });
      const [runId] = await sql`
        insert into sync_runs (source_connection_id, sync_type, status, started_at)
        values (${sourceId}, 'browser_candidate_collect', 'succeeded', now())
        returning id
      `;
      const [candidate] = await sql`
        insert into candidates (source_connection_id, external_id, display_name)
        values (${sourceId}, ${`cand-detail-${marker}`}, '示例详情')
        returning id
      `;
      candidateId = candidate.id;
      await sql`
        insert into candidate_profiles (candidate_id, current_title, current_company, location, experience_years, education, school, major)
        values (${candidate.id}, '数据工程师', '虚构科技', '北京', 8, '硕士', '虚构大学', '计算机')
      `;

      // raw_records 加密载荷含完整简历（与真实采集一致：详情合同回执整包加密落库）
      const encrypted = await encryptJsonPayload(
        {
          candidateId: `cand-detail-${marker}`,
          realName: "示例详情",
          title: "数据工程师",
          company: "虚构科技",
          yearOfExperience: 8,
          workExperiences: [
            { company: "字节跳动", title: "资深开发", city: "北京市", period: "2019.07-至今", duration: "（3年）", description: "负责容器云平台" },
            { company: "美团", title: "高级工程师", city: "北京市", period: "2016.09-2019.06", duration: "（2年9个月）", description: "负责基础设施" },
          ],
          projects: [
            { name: "基础组件容器化", description: "kafka/haproxy 容器化" },
          ],
          education: [
            { school: "虚构大学", major: "计算机", degree: "硕士", period: "2012.09-2015.04", duration: "（2年7个月）" },
          ],
        },
        { key: encryption.key, keyVersion: encryption.keyVersion },
      );
      const [rawRecord] = await sql`
        insert into raw_records (sync_run_id, source_connection_id, entity_type, external_id, schema_version, payload_ciphertext, payload_nonce, key_version, payload_hash, processing_status, captured_at)
        values (${runId.id}, ${sourceId}, 'candidate', ${`cand-detail-${marker}`}, 'liebide-candidate-detail-v1', ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.keyVersion}, ${encrypted.payloadHash}, 'normalized', now())
        returning id
      `;
      await sql`
        update candidates set raw_record_id = ${rawRecord.id} where id = ${candidate.id}
      `;

      const detail = await getCandidateById(sql, candidate.id, { encryption });
      assert.equal(detail?.name, "示例详情");
      assert.equal(detail?.title, "数据工程师");
      assert.equal(detail?.school, "虚构大学");
      assert.deepEqual(detail?.workExperiences, [
        { company: "字节跳动", title: "资深开发", city: "北京市", period: "2019.07-至今", duration: "（3年）", description: "负责容器云平台" },
        { company: "美团", title: "高级工程师", city: "北京市", period: "2016.09-2019.06", duration: "（2年9个月）", description: "负责基础设施" },
      ]);
      assert.deepEqual(detail?.projects, [{ name: "基础组件容器化", description: "kafka/haproxy 容器化" }]);
      assert.deepEqual(detail?.educationHistory, [{ school: "虚构大学", major: "计算机", degree: "硕士", period: "2012.09-2015.04", duration: "（2年7个月）" }]);

      const unknown = await getCandidateById(sql, randomUUID(), { encryption });
      assert.equal(unknown, undefined);
    } finally {
      if (sourceId) {
        await sql`delete from candidate_profiles where candidate_id = ${candidateId}`;
        await sql`delete from candidates where source_connection_id = ${sourceId}`;
        await sql`delete from raw_records where source_connection_id = ${sourceId}`;
        await sql`delete from sync_runs where source_connection_id = ${sourceId}`;
        await sql`delete from source_connections where id = ${sourceId}`;
      }
      await sql.end();
    }
  },
);
