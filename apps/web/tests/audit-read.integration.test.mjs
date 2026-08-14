import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { listAuditLogs } from "../lib/identity/audit-read-repository.mjs";

const connectionString = process.env.DATABASE_URL;

test(
  "listAuditLogs 分页/action/result 过滤/投影无多余字段",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const actions = {
      ok: `audit-read-${marker}-ok`,
      denied: `audit-read-${marker}-denied`,
      fail: `audit-read-${marker}-fail`,
    };

    try {
      // 三条夹具：不同 actor_type / result / occurred_at，均带 marker 便于精确清理
      const base = Date.now();
      const fixtures = [
        { actorType: "user", action: actions.ok, result: "success", resourceType: "job", resourceId: "job-1", at: new Date(base) },
        { actorType: "user", action: actions.denied, result: "denied", resourceType: "job", at: new Date(base - 60_000) },
        { actorType: "system", action: actions.fail, result: "failure", resourceType: "sync_run", at: new Date(base - 120_000) },
      ];
      for (const f of fixtures) {
        const inserted = await sql`
          insert into audit_logs (actor_type, action, resource_type, resource_id, result, occurred_at, request_id, metadata)
          values (${f.actorType}, ${f.action}, ${f.resourceType}, ${f.resourceId ?? null}, ${f.result}, ${f.at}, ${marker}, ${sql.json({ marker })})
        `;
        assert.equal(
          Number(inserted.count),
          1,
          `夹具 ${f.action} 插入应影响 1 行（实际 ${inserted.count}）`,
        );
      }

      // 全局集合按页面请求，断言分页切片互斥（并发写入下不断言全局总数/全局首页成员）
      const page1 = await listAuditLogs(sql, { page: 1, pageSize: 2 });
      const page2 = await listAuditLogs(sql, { page: 2, pageSize: 2 });
      assert.equal(page1.page, 1);
      assert.equal(page1.pageSize, 2);
      const ids1 = new Set(page1.list.map((r) => r.id));
      assert.ok(page2.list.every((r) => !ids1.has(r.id)), "两页切片不重叠");
      assert.ok(page1.total >= 3, "全局 total 至少含夹具行");

      // action 精确过滤
      const okRows = await listAuditLogs(sql, { action: actions.ok });
      // 诊断：直查夹具行计数，区分「查询 bug」还是「夹具行未落库」
      const [okDirect] = await sql`
        select count(*)::int as n from audit_logs where action = ${actions.ok}
      `;
      assert.equal(
        okRows.list.length,
        1,
        `action 过滤应返回夹具 ok 行；直查 action=${actions.ok} 得 ${okDirect.n} 行`,
      );
      assert.equal(okRows.list[0].action, actions.ok);
      assert.equal(okRows.list[0].result, "success");
      assert.equal(okRows.list[0].resourceId, "job-1");

      // result 过滤（夹具范围：action + result 双条件，避免全局 result 过滤 page-1 成员依赖）
      const deniedRows = await listAuditLogs(sql, {
        action: actions.denied,
        result: "denied",
      });
      assert.equal(deniedRows.list.length, 1);
      assert.equal(deniedRows.list[0].action, actions.denied);

      // 投影字段白名单：含预期键且无额外键
      const row = okRows.list[0];
      const expectedKeys = [
        "id", "occurredAt", "actorType", "actorId", "action", "resourceType",
        "resourceId", "result", "requestId", "metadata", "ipAddress",
      ];
      assert.deepEqual(Object.keys(row).sort(), [...expectedKeys].sort());
      assert.equal(row.actorType, "user");
      assert.equal(row.requestId, marker);
      assert.deepEqual(row.metadata, { marker });
      assert.equal(row.ipAddress, null);

      // q 关键词搜索：匹配 request_id / resource_id / action 子串
      const byRequest = await listAuditLogs(sql, { q: marker });
      assert.ok(
        byRequest.total >= 3 && byRequest.list.length >= 3,
        `q=${marker} 应命中全部 3 条夹具（request_id）；实际 total=${byRequest.total}`,
      );
      const byResource = await listAuditLogs(sql, { q: "job-1" });
      assert.equal(
        byResource.list.length,
        1,
        `q=job-1 应只命中 resource_id 夹具 ok 行；实际 ${byResource.list.length}`,
      );
      assert.equal(byResource.list[0].action, actions.ok);
      const byAction = await listAuditLogs(sql, { q: actions.ok });
      assert.equal(
        byAction.list.length,
        1,
        `q=${actions.ok} 应命中 action 子串夹具 ok 行；实际 ${byAction.list.length}`,
      );
      // q 与精确过滤可组合
      const combined = await listAuditLogs(sql, { q: marker, action: actions.denied });
      assert.equal(combined.list.length, 1);
      assert.equal(combined.list[0].result, "denied");
    } finally {
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        await t`delete from audit_logs where request_id = ${marker}`;
      });
      await sql.end();
    }
  },
);
