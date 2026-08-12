#!/usr/bin/env node
/**
 * 生产首次部署创建首个管理员（一次性凭证 + 强制首改密）。
 *
 * 门禁：仅允许在 production 环境运行（APP_ENV=production 或 NODE_ENV=production）；
 * 开发环境请使用 seed-dev-users.mjs。需要环境变量 ADMIN_INIT_PASSWORD 提供一次性口令，
 * 且目标组织尚无该用户名时才会创建，重复执行不产生重复管理员。
 *
 * 生产管理员登录受 TOTP 强制门禁：本脚本在创建时生成随机 TOTP 共享密钥并输出配置 URI，
 * 操作者录入认证器 App 后，首次登录即使用「口令 + 动态码」，避免「无绑定端点」的引导死锁。
 */
import postgres from "postgres";

import { hashPassword } from "../lib/identity/password-hashing.mjs";
import {
  generateTOTPSecret,
  totpProvisioningUri,
} from "../lib/identity/totp.mjs";

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
  // 预置 TOTP 共享密钥：脚本一次性输出配置 URI，操作者录入认证器后即可登录，
  // 避免「生产管理员强制 TOTP」与「无绑定端点」形成首登死锁。
  const totpSecret = generateTOTPSecret();
  const inserted = await sql`
    insert into users (
      organization_id, username, status, display_name, password_hash,
      must_change_password, totp_enabled, totp_secret
    ) values (
      ${orgId}, ${adminUsername}, 'active', '系统管理员', ${passwordHash},
      true, true, ${totpSecret}
    )
    returning id
  `;
  const userId = inserted[0].id;
  await sql`
    insert into role_assignments (user_id, role, granted_by)
    values (${userId}, 'admin', ${userId})
    on conflict (user_id, role) do nothing
  `;

  const provisioningUri = totpProvisioningUri({
    secret: totpSecret,
    accountName: adminUsername,
    issuer: "Auto Headcount",
  });
  process.stdout.write(
    [
      `已创建管理员 ${adminUsername}（一次性凭证，首次登录强制改密）。`,
      "生产管理员登录强制 TOTP：请立即将以下密钥录入您的认证器 App（如 Google Authenticator）。",
      `密钥（base32）：${totpSecret}`,
      `配置 URI：${provisioningUri}`,
      "录入完成后使用「口令 + 动态码」登录。密钥仅本次输出，请妥善保存。\n",
    ].join("\n") + "\n",
  );
} finally {
  await sql.end();
}
