import assert from "node:assert/strict";
import test from "node:test";

import { planAudit } from "../../lib/server/audit.mjs";

const BASE = {
  requestId: "req-1",
  actor: { id: "user-1" },
  action: "jobs.list",
  resourceType: "job",
};

test("成功结果：actor/result/resourceId/metadata/ip 完整投影", () => {
  const entry = planAudit({
    ...BASE,
    outcome: "success",
    metadataKeys: ["page", "pageSize", "total"],
    audit: {
      resourceId: "job-1",
      metadata: { page: 1, pageSize: 20, total: 42 },
    },
    ipAddress: "203.0.113.9",
  });
  assert.deepEqual(entry, {
    actorType: "user",
    actorId: "user-1",
    action: "jobs.list",
    resourceType: "job",
    resourceId: "job-1",
    result: "success",
    requestId: "req-1",
    ipAddress: "203.0.113.9",
    metadata: { page: 1, pageSize: 20, total: 42 },
  });
});

test("成功元数据只保留白名单键，未声明键被剔除", () => {
  const entry = planAudit({
    ...BASE,
    outcome: "success",
    metadataKeys: ["page", "pageSize", "total"],
    audit: {
      metadata: { page: 1, pageSize: 20, total: 3, username: "ops", resume: "..." },
    },
  });
  assert.deepEqual(entry.metadata, { page: 1, pageSize: 20, total: 3 });
  assert.ok(!("username" in entry.metadata));
  assert.ok(!("resume" in entry.metadata));
});

test("jobs.detail 审计元数据不得含 JD 正文（白名单只放 found）", () => {
  const entry = planAudit({
    ...BASE,
    action: "jobs.detail",
    outcome: "success",
    metadataKeys: ["found"],
    audit: {
      resourceId: "job-1",
      metadata: { found: true, jobDescription: "完整 JD 正文", resume: "..." },
    },
  });
  assert.deepEqual(entry.metadata, { found: true });
  assert.ok(!("jobDescription" in entry.metadata), "JD 正文不得进入审计元数据");
  assert.ok(!("resume" in entry.metadata));
});

test("denied 结果：元数据为空、actor 保留、resourceId 为 null", () => {
  const entry = planAudit({
    ...BASE,
    outcome: "denied",
    metadataKeys: ["page"],
    audit: { resourceId: "job-9", metadata: { page: 1 } },
  });
  assert.equal(entry.result, "denied");
  assert.equal(entry.resourceId, null);
  assert.deepEqual(entry.metadata, {});
  assert.equal(entry.actorId, "user-1");
});

test("未预期异常（failure）：无 actor 时 actorId 回落 null、元数据为空", () => {
  const entry = planAudit({
    requestId: "req-2",
    actor: null,
    action: "sync-runs.list",
    resourceType: "sync_run",
    outcome: "failure",
  });
  assert.equal(entry.result, "failure");
  assert.equal(entry.actorId, null);
  assert.equal(entry.actorType, "user");
  assert.deepEqual(entry.metadata, {});
  assert.equal(entry.requestId, "req-2");
});

test("非白名单结果（unauthorized/未知）返回 null 不写审计", () => {
  for (const outcome of ["unauthorized", "successful", "ok"]) {
    assert.equal(planAudit({ ...BASE, outcome }), null);
  }
});

test("非对象 metadata 安全回落为空对象", () => {
  const entry = planAudit({
    ...BASE,
    outcome: "success",
    metadataKeys: ["page"],
    audit: { metadata: "not-an-object" },
  });
  assert.deepEqual(entry.metadata, {});
});

test("ipAddress 缺省为 null", () => {
  const entry = planAudit({ ...BASE, outcome: "success" });
  assert.equal(entry.ipAddress, null);
});
