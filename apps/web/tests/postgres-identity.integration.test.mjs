import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

test(
  "身份表迁移可运行，用户/角色/会话唯一约束与审计写入生效",
  { skip: !connectionString },
  async () => {
    const sql = postgres(connectionString, { max: 1 });
    const marker = randomUUID();
    let orgId;
    let userId;

    try {
      const tables = await sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'organizations', 'users', 'role_assignments', 'sessions', 'audit_logs'
          )
        order by table_name
      `;
      assert.deepEqual(
        tables.map((row) => row.table_name),
        ["audit_logs", "organizations", "role_assignments", "sessions", "users"],
      );

      const [org] = await sql`
        insert into organizations (name, status)
        values (${`fixture-org-${marker}`}, 'active')
        returning id
      `;
      orgId = org.id;

      const insertUser = () => sql`
        insert into users (
          organization_id, username, display_name, password_hash
        ) values (
          ${orgId}, ${`fixture-user-${marker}`}, '集成测试用户', ${`hash-${marker}`}
        )
        returning id
      `;
      const [user] = await insertUser();
      userId = user.id;
      await assert.rejects(insertUser(), (error) => error.code === "23505");

      await sql`
        insert into role_assignments (user_id, role, granted_by)
        values (${userId}, 'admin', ${userId})
      `;
      await assert.rejects(
        sql`
          insert into role_assignments (user_id, role, granted_by)
          values (${userId}, 'admin', ${userId})
        `,
        (error) => error.code === "23505",
      );

      await sql`
        insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
        values (
          ${userId},
          ${`fixture-token-${marker}`},
          now() + interval '12 hours',
          now() + interval '30 minutes'
        )
      `;
      await assert.rejects(
        sql`
          insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
          values (${userId}, ${`fixture-token-${marker}`}, now(), now())
        `,
        (error) => error.code === "23505",
      );

      await sql`
        insert into audit_logs (
          actor_type, actor_id, action, resource_type, resource_id,
          result, request_id, metadata
        ) values (
          'user', ${userId}, 'auth.login', 'user', ${userId},
          'success', ${`fixture-req-${marker}`},
          ${sql.json({ username: "fixture-user" })}
        )
      `;
      const auditRows = await sql`
        select action, result, metadata->>'username' as "username"
        from audit_logs
        where request_id = ${`fixture-req-${marker}`}
      `;
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].action, "auth.login");
      assert.equal(auditRows[0].result, "success");
      assert.equal(auditRows[0].username, "fixture-user");
    } finally {
      if (userId) {
        await sql`delete from role_assignments where user_id = ${userId}`;
        await sql`delete from sessions where user_id = ${userId}`;
        // 追加写触发器只放行带保留标记的删除，测试清理走事务内 set local
        await sql.begin(async (t) => {
          await t`set local app.audit_retention = 'on'`;
          await t`delete from audit_logs where actor_id = ${userId}`;
        });
        await sql`delete from users where id = ${userId}`;
      }
      if (orgId) {
        await sql`delete from organizations where id = ${orgId}`;
      }
      await sql.end();
    }
  },
);
