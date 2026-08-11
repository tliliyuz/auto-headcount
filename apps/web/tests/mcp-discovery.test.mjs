import assert from "node:assert/strict";
import test from "node:test";

import {
  McpDiscoveryError,
  discoverMcpServer,
  loadMcpDiscoveryConfig,
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

test("配置缺失时在网络调用前失败，且错误不包含密钥", () => {
  assert.throws(
    () =>
      loadMcpDiscoveryConfig({
        MCP_SERVER_URL: credentials.serverUrl,
        MCP_ACCESS_KEY: credentials.accessKey,
        MCP_SECRET_KEY: "",
      }),
    (error) => {
      assert.equal(error.code, "CONFIG_INVALID");
      assert.doesNotMatch(error.message, /test-access-key/);
      return true;
    },
  );
});

test("按 initialize、initialized、tools/list 顺序发现并分页保存工具契约", async () => {
  const requests = [];
  const responses = [
    jsonResponse(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture-server", version: "1.2.3" },
        },
      },
      { headers: { "mcp-session-id": "fixture-session" } },
    ),
    new Response(null, { status: 202 }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "jobs.under_served",
            description: "List under-served jobs",
            inputSchema: {
              type: "object",
              properties: { cursor: { type: "string" } },
            },
          },
        ],
        nextCursor: "page-2",
      },
    }),
    jsonResponse({
      jsonrpc: "2.0",
      id: 3,
      result: {
        tools: [
          {
            name: "candidates.search",
            inputSchema: { type: "object", additionalProperties: false },
          },
        ],
      },
    }),
  ];

  const result = await discoverMcpServer({
    ...credentials,
    fetchedAt: "2026-08-11T00:00:00.000Z",
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return responses.shift();
    },
  });

  assert.equal(requests.length, 4);
  assert.deepEqual(
    requests.map((request) => request.body.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/list"],
  );
  assert.equal(requests[0].init.headers["X-Access-Key"], credentials.accessKey);
  assert.equal(requests[0].init.headers["X-Secret-Key"], credentials.secretKey);
  assert.equal(requests[2].init.headers["Mcp-Session-Id"], "fixture-session");
  assert.equal(
    requests[2].init.headers["MCP-Protocol-Version"],
    "2025-11-25",
  );
  assert.deepEqual(requests[3].body.params, { cursor: "page-2" });

  assert.deepEqual(result, {
    fetchedAt: "2026-08-11T00:00:00.000Z",
    protocolVersion: "2025-11-25",
    serverInfo: { name: "fixture-server", version: "1.2.3" },
    capabilities: { tools: { listChanged: false } },
    tools: [
      {
        name: "jobs.under_served",
        description: "List under-served jobs",
        inputSchema: {
          type: "object",
          properties: { cursor: { type: "string" } },
        },
      },
      {
        name: "candidates.search",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /test-(access|secret)-key/);
});

test("支持 Streamable HTTP 的 SSE JSON-RPC 响应", async () => {
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
    new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  ];

  const result = await discoverMcpServer({
    ...credentials,
    fetchImpl: async () => responses.shift(),
  });

  assert.deepEqual(result.tools, []);
});

test("鉴权失败被分类且不会泄露响应或凭证", async () => {
  await assert.rejects(
    discoverMcpServer({
      ...credentials,
      fetchImpl: async () =>
        new Response(
          `invalid credentials: ${credentials.secretKey}`,
          { status: 401 },
        ),
    }),
    (error) => {
      assert.ok(error instanceof McpDiscoveryError);
      assert.equal(error.code, "AUTH_FAILED");
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /test-secret-key/);
      return true;
    },
  );
});
