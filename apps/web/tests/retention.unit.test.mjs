import assert from "node:assert/strict";
import test from "node:test";

import { runRetention } from "../lib/jobs/retention.mjs";

const NOW = new Date("2026-08-12T00:00:00Z");

function createFakeRepo() {
  const calls = [];
  return {
    calls,
    async deleteExpiredRawRecords(input) {
      calls.push(["deleteExpiredRawRecords", input]);
      return 2;
    },
    async deleteClosedJobs(input) {
      calls.push(["deleteClosedJobs", input]);
      return 1;
    },
    async deleteExpiredSessions(input) {
      calls.push(["deleteExpiredSessions", input]);
      return 1;
    },
    async deleteExpiredAuditLogs(input) {
      calls.push(["deleteExpiredAuditLogs", input]);
      return 1;
    },
    async insertAudit(entry) {
      calls.push(["insertAudit", entry]);
    },
  };
}

test("runRetention 按 TTL 计算截止并记录清理审计", async () => {
  const repo = createFakeRepo();
  const outcome = await runRetention({
    repo,
    now: NOW,
    requestId: "ret-unit-1",
    ttl: { rawSuccessDays: 30, rawExceptionDays: 90, jobClosedDays: 180, auditDays: 365 },
  });

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(outcome.counts, {
    rawRecordsDeleted: 2,
    jobsDeleted: 1,
    sessionsDeleted: 1,
    auditLogsDeleted: 1,
  });

  const byName = new Map(repo.calls.map(([name, arg]) => [name, arg]));
  assert.ok(byName.has("deleteExpiredRawRecords"));
  assert.ok(byName.has("deleteClosedJobs"));
  assert.ok(byName.has("deleteExpiredSessions"));
  assert.ok(byName.has("deleteExpiredAuditLogs"));

  const rawInput = byName.get("deleteExpiredRawRecords");
  assert.equal(rawInput.successCutoff.toISOString(), "2026-07-13T00:00:00.000Z");
  assert.equal(rawInput.exceptionCutoff.toISOString(), "2026-05-14T00:00:00.000Z");
  assert.equal(
    byName.get("deleteClosedJobs").cutoff.toISOString(),
    "2026-02-13T00:00:00.000Z",
  );
  assert.equal(
    byName.get("deleteExpiredAuditLogs").cutoff.toISOString(),
    "2025-08-12T00:00:00.000Z",
  );

  const audit = repo.calls.find(([name]) => name === "insertAudit")[1];
  assert.equal(audit.actorType, "system");
  assert.equal(audit.action, "retention.run");
  assert.equal(audit.result, "success");
  assert.equal(audit.requestId, "ret-unit-1");
  assert.deepEqual(audit.metadata.rawRecordsDeleted, 2);
  assert.deepEqual(audit.metadata.jobsDeleted, 1);
  assert.deepEqual(audit.metadata.sessionsDeleted, 1);
  assert.deepEqual(audit.metadata.auditLogsDeleted, 1);
  assert.equal(JSON.stringify(audit).includes("password"), false);
});

test("runRetention 失败时记录 failure 审计并返回错误码，不泄露原始错误", async () => {
  const repo = createFakeRepo();
  repo.deleteExpiredSessions = async () => {
    throw new Error("connection secret leaked");
  };

  const outcome = await runRetention({ repo, now: NOW, requestId: "ret-unit-2" });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "RETENTION_INTERNAL_ERROR");

  const audit = repo.calls.find(([name]) => name === "insertAudit")[1];
  assert.ok(audit, "failure must still record an audit");
  assert.equal(audit.actorType, "system");
  assert.equal(audit.action, "retention.run");
  assert.equal(audit.result, "failure");
  assert.equal(audit.requestId, "ret-unit-2");
  assert.equal(audit.metadata.errorCode, "RETENTION_INTERNAL_ERROR");
  assert.equal(
    JSON.stringify(audit).includes("connection secret leaked"),
    false,
    "raw error message must not be persisted",
  );
});
