const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_PAGES = 100;

export class McpDiscoveryError extends Error {
  constructor(message, { code, status, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "McpDiscoveryError";
    this.code = code ?? "MCP_DISCOVERY_FAILED";
    this.status = status;
    this.retryable = retryable;
  }
}

export function loadMcpDiscoveryConfig(env = process.env) {
  return validateConfig({
    serverUrl: env.MCP_SERVER_URL,
    accessKey: env.MCP_ACCESS_KEY,
    secretKey: env.MCP_SECRET_KEY,
    timeoutMs: env.MCP_TIMEOUT_MS,
  });
}

export async function discoverMcpServer(options) {
  const config = validateConfig(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const requestedProtocolVersion =
    options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  if (typeof fetchImpl !== "function") {
    throw new McpDiscoveryError("MCP discovery requires a fetch implementation", {
      code: "CONFIG_INVALID",
    });
  }

  let requestId = 1;
  let sessionId;
  let negotiatedProtocolVersion = requestedProtocolVersion;

  const send = async (message, { expectBody = true } = {}) => {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Access-Key": config.accessKey,
      "X-Secret-Key": config.secretKey,
    };

    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (message.method !== "initialize") {
      headers["MCP-Protocol-Version"] = negotiatedProtocolVersion;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;

    try {
      response = await fetchImpl(config.serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new McpDiscoveryError("MCP request timed out", {
          code: "TIMEOUT",
          retryable: true,
          cause: error,
        });
      }
      throw new McpDiscoveryError("MCP network request failed", {
        code: "NETWORK_FAILED",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw classifyHttpError(response.status);

    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) sessionId = returnedSessionId;

    if (!expectBody || response.status === 202 || response.status === 204) {
      return undefined;
    }

    const rpcMessage = await parseRpcResponse(response);
    if (rpcMessage.error) {
      throw new McpDiscoveryError("MCP server returned a JSON-RPC error", {
        code: "RPC_ERROR",
        retryable: isRetryableRpcCode(rpcMessage.error.code),
      });
    }
    if (!("result" in rpcMessage)) {
      throw protocolError("MCP response is missing a result");
    }
    return rpcMessage.result;
  };

  const initializeResult = await send({
    jsonrpc: "2.0",
    id: requestId++,
    method: "initialize",
    params: {
      protocolVersion: requestedProtocolVersion,
      capabilities: {},
      clientInfo: { name: "auto-headcount", version: "0.1.0" },
    },
  });

  assertInitializeResult(initializeResult);
  negotiatedProtocolVersion = initializeResult.protocolVersion;

  await send(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { expectBody: false },
  );

  const tools = [];
  const seenCursors = new Set();
  let cursor;

  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await send({
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/list",
      params: cursor ? { cursor } : {},
    });
    assertToolsResult(result);
    tools.push(...result.tools.map(copyToolContract));

    if (!result.nextCursor) {
      return {
        fetchedAt,
        protocolVersion: initializeResult.protocolVersion,
        serverInfo: copyServerInfo(initializeResult.serverInfo),
        capabilities: structuredClone(initializeResult.capabilities),
        tools,
      };
    }
    if (seenCursors.has(result.nextCursor)) {
      throw protocolError("MCP tools/list returned a repeated cursor");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw protocolError("MCP tools/list exceeded the pagination limit");
}

export async function callMcpTool(options) {
  const config = validateConfig(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const toolName = requiredString(options.toolName, "toolName");
  const allowedTools = Array.isArray(options.allowedTools)
    ? options.allowedTools
    : [];
  const toolArguments = options.arguments ?? {};
  const actorId = optionalHeaderValue(options.actorId, "actorId");
  const requestedProtocolVersion =
    options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

  if (!allowedTools.includes(toolName)) {
    throw new McpDiscoveryError("MCP tool is not in the explicit allowlist", {
      code: "TOOL_NOT_ALLOWED",
    });
  }
  if (!isObject(toolArguments)) {
    throw configError("MCP tool arguments must be an object");
  }
  if (typeof fetchImpl !== "function") {
    throw configError("MCP tool call requires a fetch implementation");
  }

  let requestId = 1;
  let sessionId;
  let negotiatedProtocolVersion = requestedProtocolVersion;

  const send = async (message, { expectBody = true } = {}) => {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-Access-Key": config.accessKey,
      "X-Secret-Key": config.secretKey,
    };
    if (actorId) headers["X-Actor-Id"] = actorId;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (message.method !== "initialize") {
      headers["MCP-Protocol-Version"] = negotiatedProtocolVersion;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;

    try {
      response = await fetchImpl(config.serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new McpDiscoveryError("MCP request timed out", {
          code: "TIMEOUT",
          retryable: true,
          cause: error,
        });
      }
      throw new McpDiscoveryError("MCP network request failed", {
        code: "NETWORK_FAILED",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw classifyHttpError(response.status);
    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) sessionId = returnedSessionId;
    if (!expectBody || response.status === 202 || response.status === 204) {
      return undefined;
    }

    const rpcMessage = await parseRpcResponse(response);
    if (rpcMessage.error) {
      throw new McpDiscoveryError("MCP server returned a JSON-RPC error", {
        code: "RPC_ERROR",
        retryable: isRetryableRpcCode(rpcMessage.error.code),
      });
    }
    if (!("result" in rpcMessage)) {
      throw protocolError("MCP response is missing a result");
    }
    return rpcMessage.result;
  };

  const initializeResult = await send({
    jsonrpc: "2.0",
    id: requestId++,
    method: "initialize",
    params: {
      protocolVersion: requestedProtocolVersion,
      capabilities: {},
      clientInfo: { name: "auto-headcount", version: "0.1.0" },
    },
  });
  assertInitializeResult(initializeResult);
  negotiatedProtocolVersion = initializeResult.protocolVersion;

  await send(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { expectBody: false },
  );

  const result = await send({
    jsonrpc: "2.0",
    id: requestId++,
    method: "tools/call",
    params: { name: toolName, arguments: toolArguments },
  });
  if (!isObject(result) || !Array.isArray(result.content)) {
    throw protocolError("Invalid tools/call result");
  }
  if (result.isError === true) {
    throw new McpDiscoveryError("MCP tool reported a business error", {
      code: "TOOL_CALL_FAILED",
    });
  }
  return structuredClone(result);
}

function validateConfig(input = {}) {
  const serverUrl = requiredString(input.serverUrl, "MCP_SERVER_URL");
  const accessKey = requiredString(input.accessKey, "MCP_ACCESS_KEY");
  const secretKey = requiredString(input.secretKey, "MCP_SECRET_KEY");
  const timeoutMs = parseTimeout(input.timeoutMs);

  let parsedUrl;
  try {
    parsedUrl = new URL(serverUrl);
  } catch {
    throw configError("MCP_SERVER_URL must be a valid URL");
  }

  const isLocalHttp =
    parsedUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !isLocalHttp) {
    throw configError("MCP_SERVER_URL must use HTTPS unless it is local");
  }

  return { serverUrl: parsedUrl.href, accessKey, secretKey, timeoutMs };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${name} is required`);
  }
  return value.trim();
}

function optionalHeaderValue(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw configError(`${name} must be a valid header value`);
  }
  return value.trim();
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw configError("MCP_TIMEOUT_MS must be between 100 and 120000");
  }
  return timeoutMs;
}

function configError(message) {
  return new McpDiscoveryError(message, { code: "CONFIG_INVALID" });
}

function classifyHttpError(status) {
  if (status === 401 || status === 403) {
    return new McpDiscoveryError("MCP authentication failed", {
      code: "AUTH_FAILED",
      status,
    });
  }
  if (status === 429) {
    return new McpDiscoveryError("MCP rate limit exceeded", {
      code: "RATE_LIMITED",
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new McpDiscoveryError("MCP server is unavailable", {
      code: "SERVER_ERROR",
      status,
      retryable: true,
    });
  }
  return new McpDiscoveryError("MCP request was rejected", {
    code: "REQUEST_REJECTED",
    status,
  });
}

async function parseRpcResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return parseSseMessage(await response.text());
  }
  try {
    return await response.json();
  } catch (error) {
    throw new McpDiscoveryError("MCP returned invalid JSON", {
      code: "PROTOCOL_ERROR",
      cause: error,
    });
  }
}

function parseSseMessage(payload) {
  const data = [];
  for (const line of payload.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    if (line === "" && data.length > 0) break;
  }
  if (data.length === 0) throw protocolError("MCP SSE response has no data");
  try {
    return JSON.parse(data.join("\n"));
  } catch (error) {
    throw new McpDiscoveryError("MCP SSE response contains invalid JSON", {
      code: "PROTOCOL_ERROR",
      cause: error,
    });
  }
}

function assertInitializeResult(result) {
  if (!isObject(result)) throw protocolError("Invalid initialize result");
  if (typeof result.protocolVersion !== "string" || !result.protocolVersion) {
    throw protocolError("Initialize result has no protocol version");
  }
  if (!isObject(result.capabilities)) {
    throw protocolError("Initialize result has invalid capabilities");
  }
  if (!isObject(result.serverInfo)) {
    throw protocolError("Initialize result has invalid server info");
  }
  if (
    typeof result.serverInfo.name !== "string" ||
    typeof result.serverInfo.version !== "string"
  ) {
    throw protocolError("Initialize result has incomplete server info");
  }
}

function assertToolsResult(result) {
  if (!isObject(result) || !Array.isArray(result.tools)) {
    throw protocolError("Invalid tools/list result");
  }
  for (const tool of result.tools) {
    if (!isObject(tool) || typeof tool.name !== "string" || !tool.name) {
      throw protocolError("Tool contract has no valid name");
    }
    if (!isObject(tool.inputSchema)) {
      throw protocolError("Tool contract has no valid inputSchema");
    }
    // outputSchema 声明为可选的 JSON Schema 对象：存在时必须是普通对象（null 视为未声明），
    // 缺失时不做形状假设（当前供应商均未声明，见 docs/04）。
    if (tool.outputSchema !== undefined && tool.outputSchema !== null) {
      if (!isObject(tool.outputSchema)) {
        throw protocolError("Tool contract has no valid outputSchema");
      }
    }
  }
  if (
    result.nextCursor !== undefined &&
    (typeof result.nextCursor !== "string" || !result.nextCursor)
  ) {
    throw protocolError("tools/list returned an invalid cursor");
  }
}

function copyToolContract(tool) {
  const contract = { name: tool.name };
  for (const key of [
    "title",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "execution",
  ]) {
    if (tool[key] !== undefined) contract[key] = structuredClone(tool[key]);
  }
  return contract;
}

function copyServerInfo(serverInfo) {
  const result = { name: serverInfo.name, version: serverInfo.version };
  for (const key of ["title", "description", "websiteUrl"]) {
    if (serverInfo[key] !== undefined) result[key] = serverInfo[key];
  }
  return result;
}

function protocolError(message) {
  return new McpDiscoveryError(message, { code: "PROTOCOL_ERROR" });
}

function isRetryableRpcCode(code) {
  return typeof code === "number" && code <= -32000 && code >= -32099;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
