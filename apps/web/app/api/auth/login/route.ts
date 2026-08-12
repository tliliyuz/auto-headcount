import {
  errorResponse,
  getAuthContext,
  isSecureCookieRuntime,
  jsonResponse,
  newRequestId,
  sessionMaxAgeSeconds,
  writeAudit,
} from "../../../../lib/identity/auth-http";
import { sessionCookieValue } from "../../../../lib/identity/session-token.mjs";
import { requireSameOrigin } from "../../../../lib/identity/csrf.mjs";

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return csrfBlock;

  const requestId = newRequestId();
  let payload: { username?: unknown; password?: unknown; totpCode?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(
      { code: "invalid_request", message: "请求格式不正确" },
      400,
    );
  }

  const username = typeof payload.username === "string" ? payload.username : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const totpCode =
    typeof payload.totpCode === "string" && payload.totpCode !== ""
      ? payload.totpCode
      : undefined;

  const { service, repo } = getAuthContext();
  try {
    const sessionUser = await service.authenticate({
      username,
      password,
      totpCode,
    });
    const session = await service.createSession({
      userId: sessionUser.user.id,
    });
    const cookie = sessionCookieValue(session.token, {
      maxAgeSeconds: sessionMaxAgeSeconds(),
      secure: isSecureCookieRuntime(),
    });
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser.user.id,
      action: "auth.login",
      resourceType: "user",
      resourceId: sessionUser.user.id,
      result: "success",
      requestId,
    });
    return jsonResponse(
      {
        user: sessionUser.user,
        roles: sessionUser.roles,
        passwordChangeRequired: sessionUser.passwordChangeRequired,
      },
      200,
      { "set-cookie": cookie },
    );
  } catch (error) {
    await writeAudit(repo, {
      actorType: "user",
      actorId: null,
      action: "auth.login",
      resourceType: "user",
      result: "failure",
      requestId,
      metadata: { username },
    });
    return errorResponse(error, requestId);
  }
}
