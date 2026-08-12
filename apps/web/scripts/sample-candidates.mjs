#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  McpDiscoveryError,
  callMcpTool,
  loadMcpDiscoveryConfig,
} from "../lib/adapters/mcp-discovery.mjs";

const output = readOutputArgument(process.argv.slice(2));

try {
  const result = await callMcpTool({
    ...loadMcpDiscoveryConfig(),
    actorId: process.env.MCP_ACTOR_ID,
    toolName: "wb.candidates.list",
    arguments: { page: 1, page_size: 3, days: 90 },
    allowedTools: ["wb.candidates.list"],
  });
  const destination = resolve(process.cwd(), output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`MCP sample written to ${destination}\n`);
} catch (error) {
  if (error?.code === "EEXIST") {
    process.stderr.write("MCP_SAMPLE_OUTPUT_EXISTS: output file already exists\n");
  } else if (error instanceof McpDiscoveryError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    process.stderr.write(`${error.code}${status}: ${error.message}\n`);
  } else {
    process.stderr.write("MCP_SAMPLE_FAILED: unexpected sample failure\n");
  }
  process.exitCode = 1;
}

function readOutputArgument(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run mcp:sample-candidates -- --output <path-outside-repository>\n",
    );
    process.exit(0);
  }
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    process.stderr.write("MCP_SAMPLE_OUTPUT_REQUIRED: pass --output <path>\n");
    process.exit(2);
  }
  return value;
}
