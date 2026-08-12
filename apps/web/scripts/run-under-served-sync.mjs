#!/usr/bin/env node

import postgres from "postgres";

import { McpDiscoveryError } from "../lib/adapters/mcp-discovery.mjs";
import { runUnderServedSync } from "../lib/jobs/under-served-sync.mjs";

const connectionString = process.env.DATABASE_URL;
const encryptionKey = process.env.APP_ENCRYPTION_KEY;
const encryptionKeyVersion = process.env.APP_ENCRYPTION_KEY_VERSION;

if (!connectionString) {
  process.stderr.write(
    "DATABASE_URL_REQUIRED: set DATABASE_URL before running sync:under-served\n",
  );
  process.exit(2);
}
if (!encryptionKey || !encryptionKeyVersion) {
  process.stderr.write(
    "ENCRYPTION_CONFIG_REQUIRED: set APP_ENCRYPTION_KEY and APP_ENCRYPTION_KEY_VERSION\n",
  );
  process.exit(2);
}

const sql = postgres(connectionString, { max: 1 });
try {
  const outcome = await runUnderServedSync({
    sql,
    encryption: { key: encryptionKey, keyVersion: encryptionKeyVersion },
    source: {
      provider: "csdn-mcp",
      environment: parseEnvironment(process.env.APP_ENV),
      displayName: "CSDN Enterprise MCP",
    },
    pageSize: parsePageSize(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (outcome.status !== "succeeded") process.exitCode = 1;
} catch (error) {
  if (error instanceof McpDiscoveryError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    process.stderr.write(`${error.code}${status}: ${error.message}\n`);
  } else {
    process.stderr.write("SYNC_INTERNAL_ERROR: unexpected sync failure\n");
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}

function parsePageSize(args) {
  const index = args.indexOf("--page-size");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write("INVALID_PAGE_SIZE: --page-size must be a positive integer\n");
    process.exit(2);
  }
  return parsed;
}

function parseEnvironment(value) {
  if (value === "production" || value === "test") return value;
  return "development";
}
