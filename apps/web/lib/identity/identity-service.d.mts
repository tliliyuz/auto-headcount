import type { AuthRepository } from "./auth-repository.mjs";

export declare const LOGIN_FAILURE_THRESHOLD: number;
export declare const LOGIN_LOCK_MS: number;
export declare const LOGIN_FAILURE_MESSAGE: string;

export interface AuthUserView {
  id: string;
  username: string;
  displayName: string;
  status: string;
}

export interface AuthSessionView {
  user: AuthUserView;
  roles: string[];
  passwordChangeRequired: boolean;
}

export interface IdentityService {
  authenticate(input: {
    username: string;
    password: string;
    totpCode?: string;
  }): Promise<AuthSessionView>;
  createSession(input: {
    userId: string;
  }): Promise<{
    token: string;
    tokenHash: string;
    expiresAt: Date;
    idleExpiresAt: Date;
  }>;
  getSessionUser(token: string): Promise<AuthSessionView | null>;
  requireSession(token: string): Promise<AuthSessionView>;
  revokeSession(token: string): Promise<void>;
  changePassword(input: {
    token: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ ok: boolean }>;
  hasAnyRole(roles: string[], allowedRoles: string[]): boolean;
  authorize(
    user: { roles?: string[] } | null,
    allowedRoles: string[],
  ): boolean;
  validatePasswordPolicy(password: string): {
    ok: boolean;
    reason?: string;
  };
}

export declare function createIdentityService(deps: {
  repo: AuthRepository;
  env?: "development" | "test" | "production";
  now?: () => number;
}): IdentityService;
