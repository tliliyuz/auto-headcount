#!/usr/bin/env node
/**
 * 生产首次部署创建首个管理员（一次性凭证 + 强制首改密）。
 *
 * 门禁：仅允许在 production 环境运行（APP_ENV=production 或 NODE_ENV=production）；
 * 开发环境请使用 seed-dev-users.mjs。需要环境变量 ADMIN_INIT_PASSWORD 提供一次性口令，
 * 且目标组织尚无该用户名时才会创建，重复执行不产生重复管理员。
 *
 * 生产管理员登录受 TOTP 强制门禁：本脚本创建的管理员需先完成 TOTP 绑定才能登录。
 * 二维码绑定属管理员账号管理功能，随账号管理里程碑实现；本脚本仅建立账号。
 */
import postgres from "postgres";

import { hashPassword } from "../lib/identity/password-hashing.mjs";

const runtimeEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
if (runtimeEnv !== "production") {
  process.stderr.write(
    `init-admin 仅允许在 production 环境运行（当前：${runtimeEnv}），开发环境请用 seed-dev-users\n`,
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  process.stderr.write("需要 DATABASE_URL\n");
  process.exit(1);
}

const oneTimePassword = process.env.ADMIN_INIT_PASSWORD;
if (!oneTimePassword) {
  process.stderr.write("需要 ADMIN_INIT_PASSWORD（一次性口令）\n");
  process.exit(1);
}

const orgName = process.env.ADMIN_INIT_ORG_NAME ?? "默认组织";
const adminUsername = process.env.ADMIN_INIT_USERNAME ?? "admin";

const sql = postgres(DATABASE_URL, { max: 1 });
try {
  const existing = await sql`
    select id from users where username = ${adminUsername} limit 1
  `;
  if (existing.length) {
    process.stdout.write(`管理员账号 ${adminUsername} 已存在，跳过创建\n`);
    process.exit(0);
  }

  const orgs = await sql`
    insert into organizations (name, status)
    values (${orgName}, 'active')
    on conflict (name) do nothing
    returning id
  `;
  const orgId = orgs.length
    ? orgs[0].id
    : (await sql`select id from organizations where name = ${orgName} limit 1`)[0].id;

  const passwordHash = await hashPassword(oneTimePassword);
  const inserted = await sql`
    insert into users (
      organization_id, username, status, display_name, password_hash,
      must_change_password, totp_enabled
    ) values (
      ${orgId}, ${adminUsername}, 'active', '系统管理员', ${passwordHash},
      true, false
    )
    returning id
  `;
  const userId = inserted[0].id;
  await sql`
    insert into role_assignments (user_id, role, granted_by)
    values (${userId}, 'admin', ${userId})
    on conflict (user_id, role) do nothing
  `;

  process.stdout.write(
    [
      `已创建管理员 ${adminUsername}（一次性凭证，首次登录强制改密）。`,
      "生产管理员登录强制 TOTP：该账号需先完成 TOTP 绑定才能登录，",
      "绑定入口随账号管理功能提供。\n",
    ].join(""),
  );
} finally {
  await sql.end();
}
