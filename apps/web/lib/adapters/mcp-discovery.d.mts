export type McpToolContract = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
};

export type McpDiscoverySnapshot = {
  fetchedAt: string;
  protocolVersion: string;
  serverInfo: { name: string; version: string } & Record<string, unknown>;
  capabilities: Record<string, unknown>;
  tools: McpToolContract[];
};

export class McpDiscoveryError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
}

export function loadMcpDiscoveryConfig(env?: Record<string, string | undefined>): {
  serverUrl: string;
  accessKey: string;
  secretKey: string;
  timeoutMs: number;
};

export function discoverMcpServer(options: {
  serverUrl: string;
  accessKey: string;
  secretKey: string;
  timeoutMs?: number | string;
  protocolVersion?: string;
  fetchedAt?: string;
  fetchImpl?: typeof fetch;
}): Promise<McpDiscoverySnapshot>;

export function callMcpTool(options: {
  serverUrl: string;
  accessKey: string;
  secretKey: string;
  timeoutMs?: number | string;
  protocolVersion?: string;
  actorId?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  allowedTools: string[];
  fetchImpl?: typeof fetch;
}): Promise<{
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;
