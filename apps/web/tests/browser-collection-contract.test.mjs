import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserCollectionContractError,
  CSDN_CONNECTION_STATUS_TOOL,
  CSDN_EXTRACTION_TOOL,
  LIEBIDE_JOB_DETAIL_CONTRACT_ID,
  buildBrowserConnectionStatusArguments,
  buildJobDetailExtractionArguments,
  parseBrowserConnectionStatusResult,
  parseJobDetailExtractionResult,
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
  assert.equal(request.timeoutMs, 30000);
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
    expectedExternalId: "fixture-job-001",
  });
  assert.equal(result.status, "READY");
  assert.equal(calls[0].tool, CSDN_CONNECTION_STATUS_TOOL);
  assert.equal("browserSessionId" in calls[0].arguments, false);
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
