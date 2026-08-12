/**
 * 身份仓库：users / role_assignments / sessions / audit_logs 的持久化。
 * 使用 `postgres` tagged SQL，与 job-sync-repository 一致；不保存口令明文，
 * 审计元数据只允许白名单字段。
 */

/**
 * @typedef {object} AuthRepository
 * @property {(username: string) => Promise<object|null>} getUserByUsername
 * @property {(userId: string) => Promise<string[]>} getActiveRoles
 * @property {(userId: string, opts: {threshold: number, lockMs: number, now: number}) => Promise<object|null>} recordLoginFailure
 * @property {(userId: string) => Promise<void>} resetLoginFailures
 * @property {(input: {userId: string, tokenHash: string, expiresAt: Date, idleExpiresAt: Date}) => Promise<string>} createSession
 * @property {(tokenHash: string) => Promise<{session: object, user: object, roles: string[]}|null>} getSessionUser
 * @property {(sessionId: string, idleExpiresAt: Date) => Promise<void>} touchSession
 * @property {(tokenHash: string) => Promise<void>} revokeSessionByTokenHash
 * @property {(userId: string, input: {passwordHash: string, mustChangePassword: boolean, passwordChangedAt: Date}) => Promise<void>} updateUserPassword
 * @property {(entry: object) => Promise<void>} insertAudit
 */

export function createAuthRepository(sql) {
  return {
    async getUserByUsername(username) {
      const rows = await sql`
        select
          id,
          organization_id as "organizationId",
          username,
          status,
          display_name as "displayName",
          password_hash as "passwordHash",
          password_changed_at as "passwordChangedAt",
          must_change_password as "mustChangePassword",
          totp_secret as "totpSecret",
          totp_enabled as "totpEnabled",
          failed_attempts as "failedAttempts",
          locked_until as "lockedUntil"
        from users
        where username = ${username}
        limit 1
      `;
      return rows.length ? rows[0] : null;
    },

    async getActiveRoles(userId) {
      const rows = await sql`
        select role
        from role_assignments
        where user_id = ${userId}
          and revoked_at is null
      `;
      return rows.map((row) => row.role);
    },

    async recordLoginFailure(userId, { threshold, lockMs }) {
      const rows = await sql`
        update users
        set
          failed_attempts = failed_attempts + 1,
          locked_until = case
            when failed_attempts + 1 >= ${threshold}
              then now() + (${lockMs} * interval '1 millisecond')
            else locked_until
          end
        where id = ${userId}
        returning failed_attempts as "failedAttempts", locked_until as "lockedUntil"
      `;
      return rows.length ? rows[0] : null;
    },

    async resetLoginFailures(userId) {
      await sql`
        update users
        set failed_attempts = 0, locked_until = null
        where id = ${userId}
      `;
    },

    async createSession({ userId, tokenHash, expiresAt, idleExpiresAt }) {
      const rows = await sql`
        insert into sessions (user_id, token_hash, expires_at, idle_expires_at)
        values (
          ${userId}, ${tokenHash},
          ${expiresAt.toISOString()}, ${idleExpiresAt.toISOString()}
        )
        returning id
      `;
      return rows[0].id;
    },

    async getSessionUser(tokenHash) {
      const rows = await sql`
        select
          s.id as "sessionId",
          s.user_id as "userId",
          s.expires_at as "expiresAt",
          s.idle_expires_at as "idleExpiresAt",
          s.revoked_at as "revokedAt",
          u.username,
          u.status,
          u.display_name as "displayName",
          u.must_change_password as "mustChangePassword"
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = ${tokenHash}
        limit 1
      `;
      if (!rows.length) return null;
      const row = rows[0];
      const roles = await this.getActiveRoles(row.userId);
      return {
        session: {
          id: row.sessionId,
          userId: row.userId,
          expiresAt: row.expiresAt,
          idleExpiresAt: row.idleExpiresAt,
          revokedAt: row.revokedAt,
        },
        user: {
          id: row.userId,
          username: row.username,
          displayName: row.displayName,
          status: row.status,
          mustChangePassword: row.mustChangePassword,
        },
        roles,
      };
    },

    async touchSession(sessionId, idleExpiresAt) {
      await sql`
        update sessions
        set idle_expires_at = ${idleExpiresAt.toISOString()}
        where id = ${sessionId}
      `;
    },

    async revokeSessionByTokenHash(tokenHash) {
      await sql`
        update sessions
        set revoked_at = now()
        where token_hash = ${tokenHash}
          and revoked_at is null
      `;
    },

    async updateUserPassword(userId, { passwordHash, mustChangePassword, passwordChangedAt }) {
      await sql`
        update users
        set
          password_hash = ${passwordHash},
          must_change_password = ${mustChangePassword},
          password_changed_at = ${passwordChangedAt.toISOString()}
        where id = ${userId}
      `;
    },

    async insertAudit(entry) {
      await sql`
        insert into audit_logs (
          actor_type, actor_id, action, resource_type, resource_id,
          result, request_id, ip_address, metadata
        ) values (
          ${entry.actorType}, ${entry.actorId ?? null}, ${entry.action},
          ${entry.resourceType ?? null}, ${entry.resourceId ?? null},
          ${entry.result}, ${entry.requestId ?? null}, ${entry.ipAddress ?? null},
          ${sql.json(entry.metadata ?? {})}
        )
      `;
    },
  };
}
