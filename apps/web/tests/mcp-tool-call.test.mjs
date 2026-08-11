import assert from "node:assert/strict";
import test from "node:test";

import {
  McpDiscoveryError,
  callMcpTool,
} from "../lib/adapters/mcp-discovery.mjs";

const credentials = {
  serverUrl: "https://mcp.example.test/mcp",
  accessKey: "test-access-key",
  secretKey: "test-secret-key",
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

test("未在显式允许列表中的工具在网络请求前被拒绝", async () => {
  let fetchCalled = false;

  await assert.rejects(
    callMcpTool({
      ...credentials,
      toolName: "sms_send_marketing_lbd",
      arguments: { content: "test", candidateIds: ["candidate-1"] },
      allowedTools: ["wb.jobs.under_served"],
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must not be called");
      },
    }),
    (error) => {
      assert.ok(error instanceof McpDiscoveryError);
      assert.equal(error.code, "TOOL_NOT_ALLOWED");
      return true;
    },
  );
  assert.equal(fetchCalled, false);
});

test("最小只读调用完成握手并透传 Actor 与会话头", async () => {
  const requests = [];
  const responses = [
    jsonResponse(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-server", version: "1.0.0" },
        },
      },
      { headers: { "mcp-session-id": "fixture-session" } },
    ),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "{\"items\":[],\"total\":0}" }],
        structuredContent: { items: [], total: 0 },
        isError: false,
      },
    }),
  ];

  const result = await callMcpTool({
    ...credentials,
    actorId: "actor-fixture",
    toolName: "wb.jobs.under_served",
    arguments: { days_without_rec: 7, page: 1, page_size: 1 },
    allowedTools: ["wb.jobs.under_served"],
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return responses.shift();
    },
  });

  assert.deepEqual(
    requests.map((request) => request.body.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  assert.equal(requests[2].init.headers["Mcp-Session-Id"], "fixture-session");
  assert.equal(requests[2].init.headers["X-Actor-Id"], "actor-fixture");
  assert.deepEqual(requests[2].body.params, {
    name: "wb.jobs.under_served",
    arguments: { days_without_rec: 7, page: 1, page_size: 1 },
  });
  assert.deepEqual(result.structuredContent, { items: [], total: 0 });
});

test("工具业务错误被分类且不回显不可信正文", async () => {
  const responses = [
    jsonResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-server", version: "1.0.0" },
      },
    }),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "secret response body" }],
        isError: true,
      },
    }),
  ];

  await assert.rejects(
    callMcpTool({
      ...credentials,
      toolName: "wb.jobs.under_served",
      arguments: { page_size: 1 },
      allowedTools: ["wb.jobs.under_served"],
      fetchImpl: async () => responses.shift(),
    }),
    (error) => {
      assert.equal(error.code, "TOOL_CALL_FAILED");
      assert.doesNotMatch(error.message, /secret response body/);
      return true;
    },
  );
});
