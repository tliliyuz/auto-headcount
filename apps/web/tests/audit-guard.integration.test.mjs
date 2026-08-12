import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

import { createRetentionRepository } from "../lib/jobs/retention-repository.mjs";

const connectionString = process.env.DATABASE_URL;

test(
  "audit_logs 追加写守卫：INSERT 正常、UPDATE 被拒、DELETE 需保留标记、保留任务路径放行",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    const action = `audit-guard-${marker}`;

    try {
      // INSERT 正常（夹具行，action/request_id 用 marker 便于精确清理）
      const [row] = await sql`
        insert into audit_logs (actor_type, action, result, request_id, metadata)
        values ('test', ${action}, 'success', ${marker}, ${sql.json({ marker })})
        returning id
      `;
      const id = row.id;

      // UPDATE 无条件拒绝
      await assert.rejects(
        sql`update audit_logs set result = 'tampered' where id = ${id}`,
        /append-only|不允许|update/i,
      );

      // DELETE 无保留标记被拒
      await assert.rejects(
        sql`delete from audit_logs where id = ${id}`,
        /retention|delete|删除/i,
      );

      // 事务内 set local app.audit_retention=on 后 DELETE 放行
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        const res = await t`delete from audit_logs where id = ${id}`;
        assert.equal(Number(res.count), 1);
      });
      const [gone] = await sql`select id from audit_logs where id = ${id}`;
      assert.equal(gone, undefined);

      // 保留任务路径（仓储内部已带标记）放行：造一条过期审计并清理
      const [old] = await sql`
        insert into audit_logs (actor_type, action, result, occurred_at, request_id)
        values ('test', ${action}, 'success', now() - interval '400 days', ${marker})
        returning id
      `;
      const repo = createRetentionRepository(sql);
      // cutoff 用 200 天前（只删上面 400 天前的旧夹具行），避免 `new Date()` 全删并发测试的新审计行
      const deleted = await repo.deleteExpiredAuditLogs({
        cutoff: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      });
      assert.ok(deleted >= 1);
      const [oldGone] = await sql`select id from audit_logs where id = ${old.id}`;
      assert.equal(oldGone, undefined);
    } finally {
      // 触发器存在时直接 DELETE 被拒，清理统一走保留标记事务（触发器不存在时 set local 无害）
      await sql.begin(async (t) => {
        await t`set local app.audit_retention = 'on'`;
        await t`delete from audit_logs where request_id = ${marker}`;
      });
      await sql.end();
    }
  },
);
