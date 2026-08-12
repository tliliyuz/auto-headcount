#!/usr/bin/env node
/**
 * 开发环境种子用户（Fixture 登录）。
 *
 * 门禁：仅允许在 development 环境运行（APP_ENV / NODE_ENV 均为非 development 时拒绝），
 * 测试与生产构建无法启用此路径。种子口令为开发专用 fixture 值，可用环境变量覆盖：
 *   DEV_SEED_OPS_PASSWORD   ops 账号口令（默认 OpsPass2026!）
 *   DEV_SEED_ADMIN_PASSWORD admin 账号口令（默认 AdminPass2026!，强制首改密）
 * admin 账号启用固定 TOTP secret 便于联调，仅开发用。
 */
import postgres from "postgres";

import { hashPassword } from "../lib/identity/password-hashing.mjs";

const runtimeEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
if (runtimeEnv !== "development") {
  process.stderr.write(
    `seed-dev-users 仅允许在 development 环境运行（当前：${runtimeEnv}）\n`,
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  process.stderr.write("需要 DATABASE_URL\n");
  process.exit(1);
}

const DEFAULT_ORG_NAME = "默认组织";
const DEV_TOTP_TEST_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const opsPassword = process.env.DEV_SEED_OPS_PASSWORD ?? "OpsPass2026!";
const adminPassword = process.env.DEV_SEED_ADMIN_PASSWORD ?? "AdminPass2026!";

async function ensureOrg(sql) {
  const inserted = await sql`
    insert into organizations (name, status)
    values (${DEFAULT_ORG_NAME}, 'active')
    on conflict (name) do nothing
    returning id
  `;
  if (inserted.length) return inserted[0].id;
  const existing = await sql`
    select id from organizations where name = ${DEFAULT_ORG_NAME} limit 1
  `;
  return existing[0].id;
}

async function upsertUser(sql, orgId, {
  username,
  displayName,
  role,
  password,
  mustChangePassword,
  totpEnabled,
}) {
  const passwordHash = await hashPassword(password);
  const totpSecret = totpEnabled ? DEV_TOTP_TEST_SECRET : null;
  const existing = await sql`
    select id from users where username = ${username} limit 1
  `;
  let userId = existing[0]?.id;
  if (userId) {
    await sql`
      update users
      set
        organization_id = ${orgId},
        display_name = ${displayName},
        status = 'active',
        password_hash = ${passwordHash},
        must_change_password = ${mustChangePassword},
        totp_enabled = ${totpEnabled},
        totp_secret = ${totpSecret},
        failed_attempts = 0,
        locked_until = null
      where id = ${userId}
    `;
  } else {
    const inserted = await sql`
      insert into users (
        organization_id, username, status, display_name, password_hash,
        must_change_password, totp_enabled, totp_secret
      ) values (
        ${orgId}, ${username}, 'active', ${displayName}, ${passwordHash},
        ${mustChangePassword}, ${totpEnabled}, ${totpSecret}
      )
      returning id
    `;
    userId = inserted[0].id;
  }
  await sql`
    insert into role_assignments (user_id, role, granted_by)
    values (${userId}, ${role}, ${userId})
    on conflict (user_id, role) do nothing
  `;
  return userId;
}

const sql = postgres(DATABASE_URL, { max: 1 });
try {
  const orgId = await ensureOrg(sql);
  await upsertUser(sql, orgId, {
    username: "ops",
    displayName: "林然",
    role: "operations",
    password: opsPassword,
    mustChangePassword: false,
    totpEnabled: false,
  });
  await upsertUser(sql, orgId, {
    username: "admin",
    displayName: "系统管理员",
    role: "admin",
    password: adminPassword,
    mustChangePassword: true,
    totpEnabled: true,
  });
  process.stdout.write(
    [
      "已写入开发种子用户（仅 development）：",
      `- ops（招聘运营），口令 ${opsPassword}`,
      `- admin（系统管理员，首登强制改密 + TOTP），口令 ${adminPassword}，TOTP secret ${DEV_TOTP_TEST_SECRET}`,
      "口令可用 DEV_SEED_*_PASSWORD 覆盖；以上均为开发专用 fixture 值。\n",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
