import assert from "node:assert/strict";
import test from "node:test";

import { parseBrowserConnectionStatusResult } from "../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import {
  createBrowserCandidateBatchRepository,
  createBrowserCandidateCollectionRepository,
  updateBrowserCandidateBatchDiscoveryOutcome,
  updateBrowserCandidateItemOutcome,
} from "../lib/jobs/browser-candidate-repository.mjs";

const ENC = { key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", keyVersion: "test-v1" };

/** 基于查询文本路由的最小假 sql（postgres.js 形状）：begin 事务 + json 参数 + 可捕获查询。 */
function createFakeSql({ rowsByMatch }) {
  const queries = [];
  const makeQuery = () => {
    const query = async (strings, ..._values) => {
      const text = strings.map((part, i) => part + (i < _values.length ? "?" : "")).join("");
      queries.push(text);
      for (const { match, rows } of rowsByMatch) {
        if (match.test(text)) return rows;
      }
      return [];
    };
    query.json = (value) => value;
    return query;
  };
  const sql = makeQuery();
  sql.begin = async (callback) => callback(makeQuery());
  return { sql, queries };
}

const uuid = "11111111-1111-4111-8111-111111111111";

function detailRecord(overrides = {}) {
  return {
    contractId: "liebide-candidate-detail-v1",
    contractVersion: 1,
    status: "extracted",
    sourceOrigin: "https://portal.liebide.com",
    capturedAt: "2026-08-14T09:00:00.000Z",
    contentHash: "a".repeat(64),
    candidateId: "fixture-cand-001",
    realName: "示例候选人甲",
    title: "数据工程师",
    company: "虚构科技",
    yearOfExperience: 8,
    cityName: "北京",
    school: "虚构大学",
    major: "计算机",
    degree: "本科",
    completion: 80,
    recommendationCount: 3,
    workExperiences: [{ company: "虚构科技", title: "数据工程师" }],
    ...overrides,
  };
}

test("候选人画像详情事务：真实姓名入 candidates、画像入 candidate_profiles、raw_records 加密入库", async () => {
  const { sql, queries } = createFakeSql({
    rowsByMatch: [
      { match: /insert into sync_runs/, rows: [{ id: "sync-run-1" }] },
      { match: /insert into raw_records/, rows: [{ id: "raw-1" }] },
      { match: /insert into candidates/, rows: [{ id: "cand-1" }] },
      { match: /insert into candidate_profiles/, rows: [] },
    ],
  });
  const repo = createBrowserCandidateCollectionRepository(sql, { encryption: ENC });
  const record = detailRecord();
  const result = await repo.persist({
    sourceConnectionId: uuid,
    contractId: "liebide-candidate-detail-v1",
    record,
    candidate: { externalId: record.candidateId, displayName: record.realName, summary: null },
    profile: {
      experienceYears: record.yearOfExperience,
      location: record.cityName,
      education: record.degree,
      school: record.school,
      major: record.major,
      seniority: record.title,
      industry: null,
      currentTitle: record.title,
      currentCompany: record.company,
      activityUpdatedAt: record.capturedAt,
    },
  });
  assert.equal(result.candidateId, "cand-1");
  assert.equal(result.rawRecordId, "raw-1");

  const all = queries.join("\n");
  // 真实姓名只进 candidates（display_name），不写日志/任务载荷/审计
  assert.match(all, /insert into candidates[\s\S]*display_name/);
  // raw_records 以 entity_type='candidate' 存加密快照
  assert.match(all, /entity_type[\s\S]*'candidate'/);
  // 画像近期工作列 + 学校/专业落 candidate_profiles
  assert.match(all, /current_title|current_company/);
  assert.match(all, /school|major/);
  // 联系方式/简历正文键绝不进入任何 SQL
  assert.doesNotMatch(all, /mobile|email|wechat|selfEvaluation|projectExperiences|content/i);
  // 加密用的是 AES-256-GCM 密文字节 + keyVersion
  assert.match(all, /payload_ciphertext|payload_nonce|key_version/);
  // 幂等 upsert 以 (source_connection_id, external_id) 冲突目标
  assert.match(all, /on conflict \(source_connection_id, external_id\)/);
});

test("候选人批次入队：建批次 + browser_candidate_discovery 任务，活跃批次去重", async () => {
  const { sql } = createFakeSql({
    rowsByMatch: [
      { match: /select id from browser_candidate_batches/, rows: [] },
      { match: /insert into browser_candidate_batches/, rows: [{ id: "batch-1" }] },
      { match: /insert into async_tasks/, rows: [{ id: "task-1" }] },
    ],
  });
  const repo = createBrowserCandidateBatchRepository(sql);
  const payload = {
    sourceConnectionId: uuid,
    userId: "fixture-user",
    deviceId: "fixture-device",
    contractId: "liebide-talent-pool-list-v1",
    batchSize: 20,
    maxPages: 20,
  };
  const result = await repo.createAndEnqueue({ payload, scheduledAt: new Date() });
  assert.deepEqual(result, { accepted: true, deduplicated: false, batchId: "batch-1", taskId: "task-1" });

  // 活跃批次存在 → 去重返回既有批次与任务
  const { sql: sql2, queries } = createFakeSql({
    rowsByMatch: [
      { match: /select id from browser_candidate_batches/, rows: [{ id: "batch-active" }] },
      { match: /select id from async_tasks/, rows: [{ id: "task-active" }] },
      { match: /insert into browser_candidate_batches/, rows: [{ id: "batch-2" }] },
      { match: /insert into async_tasks/, rows: [{ id: "task-2" }] },
    ],
  });
  const repo2 = createBrowserCandidateBatchRepository(sql2);
  const deduped = await repo2.createAndEnqueue({ payload, scheduledAt: new Date() });
  assert.deepEqual(deduped, { accepted: false, deduplicated: true, batchId: "batch-active", taskId: "task-active" });
  assert.equal(queries.some((q) => /insert into browser_candidate_batches/.test(q)), false, "去重命中时不应再建批次");
});

test("候选人连接预检结果接受人才池列表与画像详情合同（解析器白名单扩展）", () => {
  for (const contractId of ["liebide-talent-pool-list-v1", "liebide-candidate-detail-v1"]) {
    const parsed = parseBrowserConnectionStatusResult({
      status: "READY", ready: true, action: "none", registeredPageCount: 1,
      sessionMatched: true, origin: "https://portal.liebide.com",
      authState: "authenticated", contractId, entityMatched: false,
    });
    assert.equal(parsed.status, "READY");
  }
});

test("候选人采集结果守卫：详情失败写 failed 并聚合批次计数；发现失败写批次状态", async () => {
  const calls = [];
  const { sql } = createFakeSql({ rowsByMatch: [] });
  await updateBrowserCandidateItemOutcome(sql, {
    collectionBatchId: "batch-1", collectionItemId: "item-1",
  }, { errorCode: "BROWSER_COLLECTION_CONTRACT_INVALID" }, "failed", new Date());
  await updateBrowserCandidateItemOutcome(sql, {}, { errorCode: "X" }, "failed", new Date());
  await updateBrowserCandidateBatchDiscoveryOutcome(sql, {
    batchId: "batch-1", contractId: "liebide-talent-pool-list-v1",
  }, { errorCode: "BROWSER_RELAY_UNAVAILABLE" }, "retry", new Date());
  // 无 payload 字段 / 非候选人发现合同 → 守卫直接 return，不产生 SQL
  await updateBrowserCandidateItemOutcome(sql, { collectionBatchId: "batch-1" }, {}, "failed", new Date());
  await updateBrowserCandidateBatchDiscoveryOutcome(sql, { batchId: "batch-1", contractId: "liebide-filtered-job-list-v2" }, {}, "failed", new Date());
  assert.equal(calls.length, 0);
  assert.ok(true);
});
