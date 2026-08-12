import { AUTH_ERROR_CODES, AuthError } from "./auth-errors.mjs";
import {
  type AuthRepository,
  type AuditEntry,
  createAuthRepository,
} from "./auth-repository.mjs";
import {
  type IdentityService,
  createIdentityService,
} from "./identity-service.mjs";
import { SESSION_MAX_MS, parseSessionToken } from "./session-token.mjs";
import { getDb } from "../server/db";
import { getRuntimeEnv } from "../server/runtime-env";

/** 统一 JSON 响应。 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** AuthError → 统一错误响应；其他异常不泄露内部细节。 */
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AuthError) {
    const status =
      error.code === AUTH_ERROR_CODES.locked
        ? 429
        : error.code === AUTH_ERROR_CODES.passwordPolicy ||
            error.code === AUTH_ERROR_CODES.invalidRequest
          ? 400
          : 401;
    return jsonResponse({ code: error.code, message: error.message }, status);
  }
  console.error(`[auth] 未预期错误 requestId=${requestId}`, error);
  return jsonResponse(
    { code: "internal_error", message: "服务器内部错误" },
    500,
  );
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function readSessionToken(request: Request): string | null {
  return parseSessionToken(request.headers.get("cookie"));
}

/** 生产环境会话 Cookie 才附加 Secure（开发走 http 需要）。 */
export function isSecureCookieRuntime(): boolean {
  return getRuntimeEnv() === "production";
}

export function sessionMaxAgeSeconds(): number {
  return Math.floor(SESSION_MAX_MS / 1000);
}

/** 组装当前请求的身份服务与仓库。 */
export function getAuthContext(): {
  service: IdentityService;
  repo: AuthRepository;
} {
  const { client } = getDb();
  const repo = createAuthRepository(client);
  const service = createIdentityService({ repo, env: getRuntimeEnv() });
  return { service, repo };
}

/**
 * 审计写入：workerd 下必须在请求上下文内完成，因此 await；
 * 失败不阻断业务响应，且只允许白名单字段（actor/action/result/requestId/metadata），
 * 绝不包含口令、哈希、令牌等。
 */
export async function writeAudit(
  repo: AuthRepository,
  entry: AuditEntry,
): Promise<void> {
  try {
    await repo.insertAudit(entry);
  } catch (error: unknown) {
    console.error(
      "[auth] 审计写入失败",
      error instanceof Error ? error.message : error,
    );
  }
}
