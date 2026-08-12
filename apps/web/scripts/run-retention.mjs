#!/usr/bin/env node

import postgres from "postgres";

import { runRetention } from "../lib/jobs/retention.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write(
    "DATABASE_URL_REQUIRED: set DATABASE_URL before running retention\n",
  );
  process.exit(2);
}

const ttl = {
  rawSuccessDays: parseIntEnv(process.env.RETENTION_RAW_SUCCESS_DAYS, 30),
  rawExceptionDays: parseIntEnv(process.env.RETENTION_RAW_EXCEPTION_DAYS, 90),
  jobClosedDays: parseIntEnv(process.env.RETENTION_JOB_CLOSED_DAYS, 180),
  auditDays: parseIntEnv(process.env.RETENTION_AUDIT_DAYS, 365),
};

const sql = postgres(connectionString, { max: 1 });
try {
  const outcome = await runRetention({
    sql,
    ttl,
    requestId:
      process.env.RETENTION_REQUEST_ID ?? `retention-${new Date().toISOString()}`,
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (outcome.status !== "succeeded") process.exitCode = 1;
} catch {
  process.stderr.write("RETENTION_FAILED: unexpected retention failure\n");
  process.exitCode = 1;
} finally {
  await sql.end();
}

function parseIntEnv(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    process.stderr.write(`INVALID_RETENTION_TTL: expected non-negative integer, got ${value}\n`);
    process.exit(2);
  }
  return parsed;
}
