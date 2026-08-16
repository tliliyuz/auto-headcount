#!/usr/bin/env node

import postgres from "postgres";

import { runJobRequirementsSync } from "../lib/jobs/job-requirements-sync.mjs";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  process.stderr.write(
    "DATABASE_URL_REQUIRED: set DATABASE_URL before running sync:job-requirements\n",
  );
  process.exit(2);
}

const sql = postgres(connectionString, { max: 1 });
try {
  const outcome = await runJobRequirementsSync({
    sql,
    source: {
      provider: "csdn-mcp",
      environment: parseEnvironment(process.env.APP_ENV),
      displayName: "CSDN Enterprise MCP",
    },
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (outcome.status !== "succeeded") process.exitCode = 1;
} catch {
  process.stderr.write("SYNC_INTERNAL_ERROR: unexpected sync failure\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}

function parseEnvironment(value) {
  if (value === "production" || value === "test") return value;
  return "development";
}
