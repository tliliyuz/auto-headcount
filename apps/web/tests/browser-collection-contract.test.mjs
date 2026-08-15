import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCollectionContractError,
  CSDN_CONNECTION_STATUS_TOOL,
  CSDN_EXTRACTION_TOOL,
  LIEBIDE_JOB_DETAIL_CONTRACT_ID,
  LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID,
  buildFilteredJobListExtractionArguments,
  buildBrowserConnectionStatusArguments,
  buildJobDetailExtractionArguments,
  parseBrowserConnectionStatusResult,
  parseJobDetailExtractionResult,
  parseFilteredJobListExtractionResult,
} from "../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import { createCsdnBrowserRelayClient } from "../lib/adapters/csdn-browser/relay-client.mjs";

const route = {
  userId: "ops_fixture",
  deviceId: "device-fixture-001",
  browserSessionId: "browser-fixture-001",
};

function validExtractionResult(overrides = {}) {
  return {
    contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    contractVersion: 1,
    status: "extracted",
    source: {
      origin: "https://portal.liebide.com",
      capturedAt: "2026-08-13T09:00:00.000Z",
    },
    record: {
      externalId: "fixture-job-001",
      title: "示例数据工程师",
      status: "active",
      city: "北京",
      salaryMin: 20000,
      salaryMax: 35000,
      jobDescription: "负责虚构数据平台建设与数据管道治理。",
      publishedAt: null,
      validRecommendationCount: null,
    },
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

test("职位详情提取参数固定契约与身份路由，不接受脚本/选择器/任意 URL", () => {
  assert.deepEqual(
    buildJobDetailExtractionArguments({
      ...route,
      expectedExternalId: "fixture-job-001",
    }),
    {
      ...route,
      contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
      expectedExternalId: "fixture-job-001",
    },
  );

  assert.deepEqual(
    buildJobDetailExtractionArguments({
      userId: route.userId,
      deviceId: route.deviceId,
      expectedExternalId: "fixture-job-001",
    }),
    {
      userId: route.userId,
      deviceId: route.deviceId,
      contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
      expectedExternalId: "fixture-job-001",
    },
  );

  assert.throws(
    () =>
      buildJobDetailExtractionArguments({
        ...route,
        expectedExternalId: "fixture-job-001",
        expression: "document.cookie",
      }),
    (error) =>
      error instanceof BrowserCollectionContractError &&
      error.code === "BROWSER_COLLECTION_ARGUMENTS_INVALID",
  );

  for (const expectedExternalId of [null, "", "job id with spaces"]) {
    assert.throws(
      () =>
        buildJobDetailExtractionArguments({
          ...route,
          expectedExternalId,
        }),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
});

test("详情提取参数支持可选期望标题用于内容校验", () => {
  assert.deepEqual(
    buildJobDetailExtractionArguments({
      ...route,
      expectedExternalId: "fixture-job-001",
      expectedTitle: "示例数据工程师",
    }),
    {
      ...route,
      contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
      expectedExternalId: "fixture-job-001",
      expectedTitle: "示例数据工程师",
    },
  );
  for (const expectedTitle of [null, "", "   ", "x".repeat(501)]) {
    assert.throws(
      () =>
        buildJobDetailExtractionArguments({
          ...route,
          expectedExternalId: "fixture-job-001",
          expectedTitle,
        }),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
});

test("连接预检使用固定合同和目标职位，严格解析最小化状态", () => {
  assert.deepEqual(
    buildBrowserConnectionStatusArguments({
      userId: route.userId,
      deviceId: route.deviceId,
      expectedExternalId: "fixture-job-001",
    }),
    {
      userId: route.userId,
      deviceId: route.deviceId,
      contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
      expectedExternalId: "fixture-job-001",
    },
  );
  assert.equal(parseBrowserConnectionStatusResult({
    status: "READY", ready: true, action: "NONE", registeredPageCount: 1,
    sessionMatched: true, origin: "https://portal.liebide.com",
    authState: "authenticated", contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    entityMatched: true,
  }).status, "READY");
  assert.throws(
    () => parseBrowserConnectionStatusResult({ status: "DEVICE_OFFLINE", ready: false }),
    BrowserCollectionContractError,
  );
});

test("解析职位详情白名单结果并保留契约版本与内容哈希", () => {
  const parsed = parseJobDetailExtractionResult(validExtractionResult());

  assert.equal(parsed.externalId, "fixture-job-001");
  assert.equal(parsed.jobDescription, "负责虚构数据平台建设与数据管道治理。");
  assert.equal(parsed.sourceOrigin, "https://portal.liebide.com");
  assert.equal(parsed.contractVersion, 1);
  assert.equal(parsed.contentHash, "a".repeat(64));
  assert.equal("companyName" in parsed, false);
});

test("错误域名、契约漂移、截断结果和敏感键均失败关闭", () => {
  const cases = [
    validExtractionResult({
      source: {
        origin: "https://evil.invalid",
        capturedAt: "2026-08-13T09:00:00.000Z",
      },
    }),
    validExtractionResult({ contractVersion: 2 }),
    validExtractionResult({ truncated: true }),
    validExtractionResult({ cookie: "must-not-cross-boundary" }),
  ];

  for (const input of cases) {
    assert.throws(
      () => parseJobDetailExtractionResult(input),
      (error) =>
        error instanceof BrowserCollectionContractError &&
        error.code === "BROWSER_COLLECTION_CONTRACT_INVALID",
    );
  }
});

test("Relay 客户端只调用固定提取工具并解析结构化结果", async () => {
  const calls = [];
  const client = createCsdnBrowserRelayClient({
    requestUrl: "http://127.0.0.1:48887/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ ok: true, result: validExtractionResult() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.extractJobDetail({
    ...route,
    expectedExternalId: "fixture-job-001",
  });

  assert.equal(result.externalId, "fixture-job-001");
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.tool, CSDN_EXTRACTION_TOOL);
  assert.deepEqual(request.arguments, {
    ...route,
    contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    expectedExternalId: "fixture-job-001",
  });
  assert.equal(request.timeoutMs, 60000);
  assert.equal(calls[0].init.headers.authorization, "Bearer fixture-relay-token");
});

test("Relay 客户端调用只读连接预检且不要求持久化 browserSessionId", async () => {
  const calls = [];
  const client = createCsdnBrowserRelayClient({
    requestUrl: "http://127.0.0.1:48887/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {
        status: "READY", ready: true, action: "NONE", registeredPageCount: 1,
        sessionMatched: true, origin: "https://portal.liebide.com",
        authState: "authenticated", contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
        entityMatched: true,
      } }));
    },
  });
  const result = await client.getConnectionStatus({
    userId: route.userId,
    deviceId: route.deviceId,
    contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    expectedExternalId: "fixture-job-001",
  });
  assert.equal(result.status, "READY");
  assert.equal(calls[0].tool, CSDN_CONNECTION_STATUS_TOOL);
  assert.equal(calls[0].arguments.contractId, LIEBIDE_JOB_DETAIL_CONTRACT_ID);
  assert.equal("browserSessionId" in calls[0].arguments, false);
});

test("Relay 转发详情提取时保留期望标题", async () => {
  const calls = [];
  const client = createCsdnBrowserRelayClient({
    requestUrl: "http://127.0.0.1:48887/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ ok: true, result: validExtractionResult() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await client.extractJobDetail({
    ...route,
    expectedExternalId: "fixture-job-001",
    expectedTitle: "示例数据工程师",
  });
  assert.equal(calls[0].arguments.expectedTitle, "示例数据工程师");
});

test("Relay 网络/HTTP/包络错误映射为机器码且不回显正文", async () => {
  const client = createCsdnBrowserRelayClient({
    requestUrl: "https://codeg.invalid/api/csdn_browser_relay/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async () => new Response("upstream secret body", { status: 503 }),
  });

  await assert.rejects(
    () =>
      client.extractJobDetail({
        ...route,
        expectedExternalId: "fixture-job-001",
      }),
    (error) => {
      assert.equal(error.code, "BROWSER_RELAY_UNAVAILABLE");
      assert.doesNotMatch(error.message, /secret body/);
      return true;
    },
  );
});

test("Docker Desktop 开发容器可通过固定主机别名连接本机 HTTP Bridge", () => {
  assert.doesNotThrow(() => createCsdnBrowserRelayClient({
    requestUrl: "http://host.docker.internal:48887/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async () => Response.json({ ok: true, result: {} }),
  }));
});

test("筛选列表合同关闭调用字段并限制批次、页数和数字断点", () => {
  assert.deepEqual(buildFilteredJobListExtractionArguments({
    userId: route.userId, deviceId: route.deviceId,
    batchSize: 20, maxPages: 3, startPage: 2,
  }), {
    userId: route.userId, deviceId: route.deviceId,
    contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID,
    batchSize: 20, maxPages: 3, startPage: 2,
  });
  for (const invalid of [
    { batchSize: 0, maxPages: 3 },
    { batchSize: 101, maxPages: 3 },
    { batchSize: 20, maxPages: 21 },
    { batchSize: 20, maxPages: 3, selector: ".job" },
  ]) assert.throws(() => buildFilteredJobListExtractionArguments({
    userId: route.userId, deviceId: route.deviceId, ...invalid,
  }), BrowserCollectionContractError);
});

test("Relay 使用 contractId 选择列表合同但不把内部选择字段重复传给关闭参数构造器", async () => {
  const calls = [];
  const client = createCsdnBrowserRelayClient({
    requestUrl: "https://codeg.invalid/api/csdn_browser_relay/mcp/request",
    token: "fixture-relay-token",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ url: String(_url), ...request });
      if (request.tool === CSDN_CONNECTION_STATUS_TOOL) {
        return Response.json({ ok: true, result: {
          status: "READY", ready: true, action: "none", registeredPageCount: 1,
          sessionMatched: true, origin: "https://portal.liebide.com", authState: "authenticated",
          contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID, entityMatched: false,
        } });
      }
      return Response.json({ ok: true, result: {
        contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID, contractVersion: 2, status: "extracted",
        source: { origin: "https://portal.liebide.com", capturedAt: "2026-08-13T09:00:00.000Z" },
        filterEvidence: { recommendationCount: 0, publishedAgeDaysMin: 0, publishedAgeDaysMax: 30 },
        items: [{ externalId: "fixture-job-001", title: "虚构职位", pageNumber: 1, position: 1 }],
        page: { startPage: 1, startOffset: 0, endPage: 1, pagesVisited: 1, nextPage: null, nextOffset: null, stopReason: "end_of_results" },
        contentHash: "b".repeat(64),
      } });
    },
  });
  const input = {
    userId: route.userId, deviceId: route.deviceId,
    contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID, batchSize: 20, maxPages: 3,
  };
  assert.equal((await client.getConnectionStatus(input)).status, "READY");
  assert.equal((await client.discoverFilteredJobs(input)).items.length, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/mcp\/local-tool$/);
  assert.match(calls[1].url, /\/mcp\/request$/);
});

test("筛选列表回执只接受筛选证据、唯一职位最小字段和有界断点", () => {
  const parsed = parseFilteredJobListExtractionResult({
    contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID,
    contractVersion: 2,
    status: "extracted",
    source: { origin: "https://portal.liebide.com", capturedAt: "2026-08-13T09:00:00.000Z" },
    filterEvidence: { recommendationCount: 0, publishedAgeDaysMin: 0, publishedAgeDaysMax: 30 },
    items: [
      { externalId: "fixture-job-001", title: "虚构职位一", pageNumber: 2, position: 1 },
      { externalId: "fixture-job-002", title: "虚构职位二", pageNumber: 2, position: 2 },
    ],
    page: { startPage: 2, startOffset: 0, endPage: 2, pagesVisited: 1, nextPage: 2, nextOffset: 2, stopReason: "batch_size" },
    contentHash: "b".repeat(64),
  }, { batchSize: 2, maxPages: 3 });
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.nextPage, 2);
  assert.equal(parsed.nextOffset, 2);
  assert.throws(() => parseFilteredJobListExtractionResult({
    ...parsed,
    items: [...parsed.items, parsed.items[0]],
  }, { batchSize: 2, maxPages: 3 }), BrowserCollectionContractError);
});
