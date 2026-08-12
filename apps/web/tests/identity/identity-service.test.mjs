import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword } from "../../lib/identity/password-hashing.mjs";
import { generateTOTP } from "../../lib/identity/totp.mjs";
import {
  AUTH_ERROR_CODES,
  AuthError,
} from "../../lib/identity/auth-errors.mjs";
import { createIdentityService } from "../../lib/identity/identity-service.mjs";
import {
  validatePasswordPolicy,
} from "../../lib/identity/password-policy.mjs";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const NOW_MS = 1234567890 * 1000;

function createMemoryRepo(seed = {}) {
  const users = new Map(
    (seed.users ?? []).map((u) => [u.username, { ...u }]),
  );
  const roles = (seed.roles ?? []).map((r) => ({ ...r }));
  const sessions = new Map();
  const audit = [];
  const byId = (userId) => [...users.values()].find((u) => u.id === userId);
  return {
    audit,
    async getUserByUsername(username) {
      return users.get(username) ?? null;
    },
    async getActiveRoles(userId) {
      return roles
        .filter((r) => r.userId === userId && !r.revokedAt)
        .map((r) => r.role);
    },
    async recordLoginFailure(userId, { threshold, lockMs, now }) {
      const user = byId(userId);
      if (!user) return { failedAttempts: 0, lockedUntil: null };
      user.failedAttempts = (user.failedAttempts ?? 0) + 1;
      if (user.failedAttempts >= threshold) user.lockedUntil = now + lockMs;
      return { failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil };
    },
    async resetLoginFailures(userId) {
      const user = byId(userId);
      if (user) {
        user.failedAttempts = 0;
        user.lockedUntil = null;
      }
    },
    async createSession({ userId, tokenHash, expiresAt, idleExpiresAt }) {
      const id = `session-${sessions.size + 1}`;
      sessions.set(tokenHash, {
        id,
        userId,
        tokenHash,
        expiresAt,
        idleExpiresAt,
        revokedAt: null,
      });
      return id;
    },
    async getSessionUser(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session) return null;
      const user = byId(session.userId);
      if (!user) return null;
      return {
        session,
        user,
        roles: roles
          .filter((r) => r.userId === user.id && !r.revokedAt)
          .map((r) => r.role),
      };
    },
    async touchSession(id, idleExpiresAt) {
      const session = [...sessions.values()].find((s) => s.id === id);
      if (session) session.idleExpiresAt = idleExpiresAt;
    },
    async revokeSessionByTokenHash(tokenHash) {
      const session = sessions.get(tokenHash);
      if (session) session.revokedAt = new Date();
    },
    async updateUserPassword(userId, { passwordHash, mustChangePassword, passwordChangedAt }) {
      const user = byId(userId);
      if (user) {
        user.passwordHash = passwordHash;
        user.mustChangePassword = mustChangePassword;
        user.passwordChangedAt = passwordChangedAt;
      }
    },
    async insertAudit(entry) {
      audit.push(entry);
    },
  };
}

async function seedBaseUsers() {
  return [
    {
      id: "u-ops",
      username: "ops",
      status: "active",
      displayName: "林然",
      passwordHash: await hashPassword("OpsPass2026!"),
      mustChangePassword: false,
      totpEnabled: false,
      failedAttempts: 0,
      lockedUntil: null,
    },
    {
      id: "u-admin",
      username: "admin",
      status: "active",
      displayName: "系统管理员",
      passwordHash: await hashPassword("AdminPass2026!"),
      mustChangePassword: true,
      totpEnabled: false,
      failedAttempts: 0,
      lockedUntil: null,
    },
    {
      id: "u-admin-totp",
      username: "admin-totp",
      status: "active",
      displayName: "启用 TOTP 管理员",
      passwordHash: await hashPassword("AdminPass2026!"),
      mustChangePassword: false,
      totpEnabled: true,
      totpSecret: RFC_SECRET,
      failedAttempts: 0,
      lockedUntil: null,
    },
    {
      id: "u-disabled",
      username: "fired",
      status: "disabled",
      displayName: "已离职",
      passwordHash: await hashPassword("FiredPass2026!"),
      mustChangePassword: false,
      totpEnabled: false,
      failedAttempts: 0,
      lockedUntil: null,
    },
  ];
}

function rolesFor() {
  return [
    { userId: "u-ops", role: "operations" },
    { userId: "u-admin", role: "admin" },
    { userId: "u-admin-totp", role: "admin" },
  ];
}

function makeService(repo, env = "development", clock = () => NOW_MS) {
  return createIdentityService({ repo, env, now: clock });
}

test("正确口令登录成功并返回用户与角色", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);
  const result = await service.authenticate({ username: "ops", password: "OpsPass2026!" });
  assert.equal(result.user.username, "ops");
  assert.equal(result.user.displayName, "林然");
  assert.deepEqual(result.roles, ["operations"]);
  assert.equal(result.passwordChangeRequired, false);
});

test("错误口令与未知账号返回统一错误，且不泄露账号是否存在", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);
  for (const attempt of [
    { username: "ops", password: "WrongPass2026!" },
    { username: "no-such-user", password: "OpsPass2026!" },
  ]) {
    await assert.rejects(
      service.authenticate(attempt),
      (err) =>
        err instanceof AuthError &&
        err.code === AUTH_ERROR_CODES.invalidCredentials &&
        err.message === "账号或口令不正确",
    );
  }
});

test("连续 5 次失败后临时锁定，锁定期满恢复", async () => {
  let t = NOW_MS;
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo, "development", () => t);

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      service.authenticate({ username: "ops", password: "WrongPass2026!" }),
      (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
    );
  }
  await assert.rejects(
    service.authenticate({ username: "ops", password: "OpsPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.locked,
  );

  // 锁定期满（15 分钟）后恢复
  t += 16 * 60 * 1000;
  const result = await service.authenticate({
    username: "ops",
    password: "OpsPass2026!",
  });
  assert.equal(result.user.username, "ops");
});

test("已禁用用户即使口令正确也被拒绝", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);
  await assert.rejects(
    service.authenticate({ username: "fired", password: "FiredPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
  );
});

test("首次登录（mustChangePassword）透出强制改密标记", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);
  const result = await service.authenticate({
    username: "admin",
    password: "AdminPass2026!",
  });
  assert.equal(result.passwordChangeRequired, true);
  assert.deepEqual(result.roles, ["admin"]);
});

test("生产管理员未绑定 TOTP 前不能登录", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo, "production");
  await assert.rejects(
    service.authenticate({ username: "admin", password: "AdminPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.totpRequired,
  );
});

test("生产管理员绑定 TOTP 后必须校验正确验证码", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo, "production");
  const code = await generateTOTP(RFC_SECRET, { now: NOW_MS });

  const ok = await service.authenticate({
    username: "admin-totp",
    password: "AdminPass2026!",
    totpCode: code,
  });
  assert.equal(ok.user.username, "admin-totp");

  await assert.rejects(
    service.authenticate({
      username: "admin-totp",
      password: "AdminPass2026!",
      totpCode: "000000",
    }),
    (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
  );
});

test("非生产环境下已绑定 TOTP 的账号仍需正确验证码", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo, "development");
  const code = await generateTOTP(RFC_SECRET, { now: NOW_MS });
  assert.equal(
    (await service.authenticate({ username: "admin-totp", password: "AdminPass2026!", totpCode: code })).user.username,
    "admin-totp",
  );
  await assert.rejects(
    service.authenticate({ username: "admin-totp", password: "AdminPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
  );
});

test("会话创建/读取/登出撤销全生命周期", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);

  const { token } = await service.createSession({ userId: "u-ops" });
  const session = await service.getSessionUser(token);
  assert.equal(session.user.username, "ops");
  assert.equal(session.passwordChangeRequired, false);

  await service.revokeSession(token);
  assert.equal(await service.getSessionUser(token), null);
});

test("会话最长有效期与空闲超时到期后失效", async () => {
  let t = NOW_MS;
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo, "development", () => t);
  const { token } = await service.createSession({ userId: "u-ops" });
  assert.notEqual(await service.getSessionUser(token), null);

  // 空闲超时（30 分钟）后失效
  t += 31 * 60 * 1000;
  assert.equal(await service.getSessionUser(token), null);

  // 新会话在最长有效期（12 小时）后失效
  const { token: token2 } = await service.createSession({ userId: "u-ops" });
  t += 13 * 60 * 60 * 1000;
  assert.equal(await service.getSessionUser(token2), null);
});

test("改密：错误当前口令拒绝，弱口令拒绝，成功后清强制改密", async () => {
  const repo = createMemoryRepo({ users: await seedBaseUsers(), roles: rolesFor() });
  const service = makeService(repo);
  const { token } = await service.createSession({ userId: "u-admin" });

  await assert.rejects(
    service.changePassword({ token, currentPassword: "WrongPass2026!", newPassword: "BrandNewPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
  );
  await assert.rejects(
    service.changePassword({ token, currentPassword: "AdminPass2026!", newPassword: "short" }),
    (err) => err.code === AUTH_ERROR_CODES.passwordPolicy,
  );

  const result = await service.changePassword({
    token,
    currentPassword: "AdminPass2026!",
    newPassword: "BrandNewPass2026!",
  });
  assert.equal(result.ok, true);

  const user = await repo.getUserByUsername("admin");
  assert.equal(user.mustChangePassword, false);
  const session = await service.getSessionUser(token);
  assert.equal(session.passwordChangeRequired, false);
  // 旧口令立即失效
  await assert.rejects(
    service.authenticate({ username: "admin", password: "AdminPass2026!" }),
    (err) => err.code === AUTH_ERROR_CODES.invalidCredentials,
  );
});

test("口令策略：最短 12 位、含字母与数字、拒绝常见弱口令", () => {
  assert.equal(validatePasswordPolicy("OpsPass2026!").ok, true);
  assert.equal(validatePasswordPolicy("short1A").ok, false);
  assert.equal(validatePasswordPolicy("aaaaaaaaaaaa").ok, false);
  assert.equal(validatePasswordPolicy("123456789012").ok, false);
  assert.equal(validatePasswordPolicy("password123456").ok, false);
});

test("authorize：operations/recruiter/admin 服务端判定（严格成员）", () => {
  const service = makeService(createMemoryRepo({}));
  assert.equal(service.authorize({ roles: ["operations"] }, ["operations"]), true);
  assert.equal(service.authorize({ roles: ["operations"] }, ["admin"]), false);
  assert.equal(service.authorize({ roles: ["recruiter"] }, ["operations", "recruiter"]), true);
  assert.equal(service.authorize({ roles: ["admin"] }, ["admin"]), true);
  assert.equal(service.authorize({ roles: ["admin"] }, ["operations"]), false);
  assert.equal(service.authorize({ roles: ["admin", "operations"] }, ["operations"]), true);
  assert.equal(service.authorize({ roles: [] }, ["operations"]), false);
});
