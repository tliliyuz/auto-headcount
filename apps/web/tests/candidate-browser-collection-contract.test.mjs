import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCollectionContractError,
  LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
  LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
  buildTalentPoolListExtractionArguments,
  buildCandidateDetailExtractionArguments,
  buildTalentPoolListConnectionStatusArguments,
  parseTalentPoolListExtractionResult,
  parseCandidateDetailExtractionResult,
} from "../lib/adapters/csdn-browser/browser-collection-contract.mjs";

const route = {
  userId: "ops_fixture",
  deviceId: "device-fixture-001",
  browserSessionId: "browser-fixture-001",
};

function validTalentPoolListResult(overrides = {}) {
  return {
    contractId: LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
    contractVersion: 1,
    status: "extracted",
    source: { origin: "https://portal.liebide.com", capturedAt: "2026-08-14T09:00:00.000Z" },
    filterEvidence: { category: "互联网技术其他" },
    items: [
      {
        candidateId: "fixture-cand-001",
        realName: "示例候选人甲",
        title: "数据工程师",
        company: "虚构科技",
        yearOfExperience: 8,
        age: 34,
        gender: "男",
        city: "北京",
        education: "本科",
        pageNumber: 1,
        position: 1,
      },
      {
        candidateId: "fixture-cand-002",
        realName: "示例候选人乙",
        title: "算法工程师",
        company: "虚构数据",
        yearOfExperience: 6,
        age: 31,
        gender: "女",
        city: "上海",
        education: "硕士",
        pageNumber: 1,
        position: 2,
      },
    ],
    page: { startPage: 1, startOffset: 0, endPage: 1, pagesVisited: 1, nextPage: 1, nextOffset: 2, stopReason: "batch_size" },
    contentHash: "c".repeat(64),
    ...overrides,
  };
}

function validCandidateDetailResult(overrides = {}) {
  return {
    contractId: LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
    contractVersion: 1,
    status: "extracted",
    source: { origin: "https://portal.liebide.com", capturedAt: "2026-08-14T09:00:00.000Z" },
    record: {
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
    },
    contentHash: "d".repeat(64),
    ...overrides,
  };
}

test("人才池列表提取参数固定合同与有界翻页，不接受脚本/选择器/任意 URL", () => {
  assert.deepEqual(
    buildTalentPoolListExtractionArguments({
      userId: route.userId,
      deviceId: route.deviceId,
      batchSize: 20,
      maxPages: 3,
      startPage: 2,
    }),
    {
      userId: route.userId,
      deviceId: route.deviceId,
      contractId: LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
      batchSize: 20,
      maxPages: 3,
      startPage: 2,
    },
  );

  for (const invalid of [
    { batchSize: 0, maxPages: 3 },
    { batchSize: 101, maxPages: 3 },
    { batchSize: 20, maxPages: 21 },
    { batchSize: 20, maxPages: 3, selector: ".candidate" },
  ]) {
    assert.throws(
      () =>
        buildTalentPoolListExtractionArguments({
          userId: route.userId,
          deviceId: route.deviceId,
          ...invalid,
        }),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
});

test("候选人详情提取参数固定合同与身份路由", () => {
  assert.deepEqual(
    buildCandidateDetailExtractionArguments({
      ...route,
      expectedCandidateId: "fixture-cand-001",
      expectedTitle: "数据工程师",
    }),
    {
      ...route,
      contractId: LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
      expectedCandidateId: "fixture-cand-001",
      expectedTitle: "数据工程师",
    },
  );
  for (const expectedCandidateId of [null, "", "candidate id with spaces"]) {
    assert.throws(
      () =>
        buildCandidateDetailExtractionArguments({
          ...route,
          expectedCandidateId,
        }),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
});

test("人才池连接预检使用固定合同与有界翻页参数", () => {
  assert.deepEqual(
    buildTalentPoolListConnectionStatusArguments({
      userId: route.userId,
      deviceId: route.deviceId,
      batchSize: 20,
      maxPages: 3,
    }),
    {
      userId: route.userId,
      deviceId: route.deviceId,
      contractId: LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
    },
  );
});

test("解析人才池列表回执：白名单字段、唯一 ID、有界断点与固定分类证据", () => {
  const parsed = parseTalentPoolListExtractionResult(
    validTalentPoolListResult(),
    { batchSize: 2, maxPages: 3 },
  );
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].candidateId, "fixture-cand-001");
  assert.equal(parsed.items[0].realName, "示例候选人甲");
  assert.equal(parsed.filterEvidence.category, "互联网技术其他");
  assert.equal(parsed.nextPage, 1);
  assert.equal(parsed.nextOffset, 2);

  assert.throws(
    () =>
      parseTalentPoolListExtractionResult(
        {
          ...validTalentPoolListResult(),
          items: [...validTalentPoolListResult().items, validTalentPoolListResult().items[0]],
        },
        { batchSize: 2, maxPages: 3 },
      ),
    BrowserCollectionContractError,
  );

  assert.throws(
    () =>
      parseTalentPoolListExtractionResult(
        {
          ...validTalentPoolListResult(),
          filterEvidence: { category: "运营" },
        },
        { batchSize: 2, maxPages: 3 },
      ),
    BrowserCollectionContractError,
  );
});

test("解析候选人详情回执：白名单画像、真实姓名保留、联系方式/简历正文拒绝", () => {
  const parsed = parseCandidateDetailExtractionResult(validCandidateDetailResult());
  assert.equal(parsed.candidateId, "fixture-cand-001");
  assert.equal(parsed.realName, "示例候选人甲");
  assert.equal(parsed.title, "数据工程师");
  assert.equal(parsed.cityName, "北京");
  assert.equal(parsed.school, "虚构大学");
  assert.equal(parsed.completion, 80);
  assert.deepEqual(parsed.workExperiences, [{ company: "虚构科技", title: "数据工程师" }]);

  // 联系方式 / 简历正文必须失败关闭（不进 candidates，也不进 LLM 投影）
  const forbiddenKeys = ["mobile", "email", "wechat", "content", "selfEvaluation", "projectExperiences"];
  for (const key of forbiddenKeys) {
    assert.throws(
      () =>
        parseCandidateDetailExtractionResult(
          validCandidateDetailResult({ record: { ...validCandidateDetailResult().record, [key]: "must-not-cross-boundary" } }),
        ),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_CONTRACT_INVALID",
    );
  }

  // 错误域名 / 契约版本漂移失败关闭
  assert.throws(
    () =>
      parseCandidateDetailExtractionResult(
        validCandidateDetailResult({
          source: { origin: "https://evil.invalid", capturedAt: "2026-08-14T09:00:00.000Z" },
        }),
      ),
    BrowserCollectionContractError,
  );
  assert.throws(
    () => parseCandidateDetailExtractionResult(validCandidateDetailResult({ contractVersion: 2 })),
    BrowserCollectionContractError,
  );
});
