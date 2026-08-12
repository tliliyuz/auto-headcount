import { AUTH_ERROR_CODES, AuthError } from "./auth-errors.mjs";
import {
  DUMMY_BCRYPT_HASH,
  hashPassword,
  verifyPassword,
} from "./password-hashing.mjs";
import { validatePasswordPolicy } from "./password-policy.mjs";
import {
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  generateSessionToken,
  hashSessionToken,
} from "./session-token.mjs";
import { verifyTOTP } from "./totp.mjs";

/** 连续失败阈值与锁定窗口（规范口径：阈值如 5 次）。 */
export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_MESSAGE = "账号或口令不正确";

function toMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * 身份服务：登录校验、会话、改密与授权判定。
 * @param {object} deps
 * @param {import("./auth-repository.mjs").AuthRepository} deps.repo 持久化仓库（可注入内存实现测试）
 * @param {"development"|"test"|"production"} [deps.env] 运行时环境，生产管理员强制 TOTP
 * @param {() => number} [deps.now] 时钟注入，测试可控
 */
export function createIdentityService({
  repo,
  env = "development",
  now = () => Date.now(),
}) {
  /** 登录：统一失败文案，不区分账号是否存在；连续失败锁定；生产管理员强制 TOTP。 */
  async function authenticate({ username, password, totpCode }) {
    if (typeof username !== "string" || typeof password !== "string") {
      throw new AuthError(AUTH_ERROR_CODES.invalidCredentials, LOGIN_FAILURE_MESSAGE);
    }
    const user = await repo.getUserByUsername(username);

    if (user && user.lockedUntil && toMs(user.lockedUntil) > now()) {
      throw new AuthError(AUTH_ERROR_CODES.locked, "登录失败次数过多，账号已临时锁定");
    }

    let passwordOk;
    if (user) {
      passwordOk = await verifyPassword(password, user.passwordHash);
    } else {
      // 账号不存在也执行一次比较，避免响应时长泄露账号存在性
      await verifyPassword(password, DUMMY_BCRYPT_HASH);
      passwordOk = false;
    }

    if (!passwordOk) {
      if (user) {
        await repo.recordLoginFailure(user.id, {
          threshold: LOGIN_FAILURE_THRESHOLD,
          lockMs: LOGIN_LOCK_MS,
          now: now(),
        });
      }
      throw new AuthError(AUTH_ERROR_CODES.invalidCredentials, LOGIN_FAILURE_MESSAGE);
    }

    if (user.status !== "active") {
      throw new AuthError(AUTH_ERROR_CODES.invalidCredentials, LOGIN_FAILURE_MESSAGE);
    }

    await repo.resetLoginFailures(user.id);
    const roles = await repo.getActiveRoles(user.id);
    const isAdmin = roles.includes("admin");

    if (env === "production" && isAdmin && !user.totpEnabled) {
      throw new AuthError(AUTH_ERROR_CODES.totpRequired, "管理员账号需先绑定 TOTP 才能登录");
    }
    if (user.totpEnabled) {
      if (!totpCode || !(await verifyTOTP(user.totpSecret, totpCode, { now: now() }))) {
        throw new AuthError(AUTH_ERROR_CODES.invalidCredentials, LOGIN_FAILURE_MESSAGE);
      }
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        status: user.status,
      },
      roles,
      passwordChangeRequired: user.mustChangePassword === true,
    };
  }

  /** 创建会话，返回可写入 Cookie 的原始令牌。 */
  async function createSession({ userId }) {
    const { token, tokenHash } = await generateSessionToken();
    const current = now();
    const expiresAt = new Date(current + SESSION_MAX_MS);
    const idleExpiresAt = new Date(current + SESSION_IDLE_MS);
    await repo.createSession({ userId, tokenHash, expiresAt, idleExpiresAt });
    return { token, tokenHash, expiresAt, idleExpiresAt };
  }

  /** 依据会话令牌读取用户与会话，校验未撤销、未过期、用户有效；刷新空闲窗口。 */
  async function getSessionUser(token) {
    if (typeof token !== "string" || token === "") return null;
    const tokenHash = await hashSessionToken(token);
    const row = await repo.getSessionUser(tokenHash);
    if (!row) return null;
    const { session, user, roles } = row;
    const current = now();
    if (session.revokedAt) return null;
    if (toMs(session.expiresAt) <= current) return null;
    if (toMs(session.idleExpiresAt) <= current) return null;
    if (user.status !== "active") return null;

    await repo.touchSession(session.id, new Date(current + SESSION_IDLE_MS));
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        status: user.status,
      },
      roles,
      passwordChangeRequired: user.mustChangePassword === true,
    };
  }

  /** 撤销会话（登出/禁用/角色变更）。 */
  async function revokeSession(token) {
    if (typeof token !== "string" || token === "") return;
    const tokenHash = await hashSessionToken(token);
    await repo.revokeSessionByTokenHash(tokenHash);
  }

  /** 要求有效会话，否则抛 unauthorized。 */
  async function requireSession(token) {
    const session = await getSessionUser(token);
    if (!session) {
      throw new AuthError(AUTH_ERROR_CODES.unauthorized, "未登录或会话已失效");
    }
    return session;
  }

  /** 改密：校验当前口令与策略，成功后清强制改密并让旧口令立即失效。 */
  async function changePassword({ token, currentPassword, newPassword }) {
    const session = await requireSession(token);
    const user = await repo.getUserByUsername(session.user.username);
    const currentOk = await verifyPassword(currentPassword, user.passwordHash);
    if (!currentOk) {
      throw new AuthError(AUTH_ERROR_CODES.invalidCredentials, "当前口令不正确");
    }
    const policy = validatePasswordPolicy(newPassword);
    if (!policy.ok) {
      throw new AuthError(AUTH_ERROR_CODES.passwordPolicy, policy.reason);
    }
    const newHash = await hashPassword(newPassword);
    await repo.updateUserPassword(user.id, {
      passwordHash: newHash,
      mustChangePassword: false,
      passwordChangedAt: new Date(now()),
    });
    return { ok: true };
  }

  /** 角色集合是否命中任一允许角色（纯函数）。 */
  function hasAnyRole(roles, allowedRoles) {
    return Array.isArray(roles) && roles.some((role) => allowedRoles.includes(role));
  }

  /** 授权判定：用户（含 roles）是否允许执行 allowedRoles 覆盖的操作。 */
  function authorize(user, allowedRoles) {
    return hasAnyRole(user?.roles, allowedRoles);
  }

  return {
    authenticate,
    createSession,
    getSessionUser,
    requireSession,
    revokeSession,
    changePassword,
    hasAnyRole,
    authorize,
    validatePasswordPolicy,
  };
}
