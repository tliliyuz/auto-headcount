#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  McpDiscoveryError,
  discoverMcpServer,
  loadMcpDiscoveryConfig,
} from "../lib/adapters/mcp-discovery.mjs";

const output = readOutputArgument(process.argv.slice(2));

try {
  const snapshot = await discoverMcpServer(loadMcpDiscoveryConfig());
  const destination = resolve(process.cwd(), output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`MCP discovery snapshot written to ${destination}\n`);
} catch (error) {
  if (error?.code === "EEXIST") {
    process.stderr.write("MCP_DISCOVERY_OUTPUT_EXISTS: output file already exists\n");
  } else if (error instanceof McpDiscoveryError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    process.stderr.write(`${error.code}${status}: ${error.message}\n`);
  } else {
    process.stderr.write("MCP_DISCOVERY_FAILED: unexpected discovery failure\n");
  }
  process.exitCode = 1;
}

function readOutputArgument(args) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: npm run mcp:discover -- --output <path-to-sanitized-json>\n",
    );
    process.exit(0);
  }
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    process.stderr.write("MCP_DISCOVERY_OUTPUT_REQUIRED: pass --output <path>\n");
    process.exit(2);
  }
  return value;
}
