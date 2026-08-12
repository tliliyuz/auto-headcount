import type postgres from "postgres";

export interface AuthRepositoryUser {
  id: string;
  organizationId: string;
  username: string;
  status: string;
  displayName: string;
  passwordHash: string;
  passwordChangedAt: Date | null;
  mustChangePassword: boolean;
  totpSecret: string | null;
  totpEnabled: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface AuthRepositorySessionRow {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    idleExpiresAt: Date;
    revokedAt: Date | null;
  };
  user: {
    id: string;
    username: string;
    displayName: string;
    status: string;
    mustChangePassword: boolean;
  };
  roles: string[];
}

export interface AuditEntry {
  actorType: string;
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: string;
  requestId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuthRepository {
  getUserByUsername(username: string): Promise<AuthRepositoryUser | null>;
  getActiveRoles(userId: string): Promise<string[]>;
  recordLoginFailure(
    userId: string,
    opts: { threshold: number; lockMs: number; now: number },
  ): Promise<{ failedAttempts: number; lockedUntil: Date | null } | null>;
  resetLoginFailures(userId: string): Promise<void>;
  createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    idleExpiresAt: Date;
  }): Promise<string>;
  getSessionUser(tokenHash: string): Promise<AuthRepositorySessionRow | null>;
  touchSession(sessionId: string, idleExpiresAt: Date): Promise<void>;
  revokeSessionByTokenHash(tokenHash: string): Promise<void>;
  updateUserPassword(
    userId: string,
    input: {
      passwordHash: string;
      mustChangePassword: boolean;
      passwordChangedAt: Date;
    },
  ): Promise<void>;
  insertAudit(entry: AuditEntry): Promise<void>;
}

export declare function createAuthRepository(
  sql: postgres.Sql,
): AuthRepository;
