import {
  errorResponse,
  getAuthContext,
  jsonResponse,
  newRequestId,
  readSessionToken,
  writeAudit,
} from "../../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../../lib/identity/csrf.mjs";

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return csrfBlock;

  const requestId = newRequestId();
  let payload: { currentPassword?: unknown; newPassword?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(
      { code: "invalid_request", message: "请求格式不正确" },
      400,
    );
  }

  const currentPassword =
    typeof payload.currentPassword === "string" ? payload.currentPassword : "";
  const newPassword =
    typeof payload.newPassword === "string" ? payload.newPassword : "";

  const { service, repo } = getAuthContext();
  const token = readSessionToken(request);
  if (!token) {
    return jsonResponse(
      { code: "unauthorized", message: "未登录或会话已失效" },
      401,
    );
  }

  try {
    await service.changePassword({ token, currentPassword, newPassword });
    const sessionUser = await service.getSessionUser(token);
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser?.user.id ?? null,
      action: "auth.password_change",
      resourceType: "user",
      resourceId: sessionUser?.user.id ?? null,
      result: "success",
      requestId,
    });
    return jsonResponse({ ok: true });
  } catch (error) {
    // 与成功分支一致：workerd 下审计必须在本请求上下文内完成，故 await。
    await writeAudit(repo, {
      actorType: "user",
      actorId: null,
      action: "auth.password_change",
      resourceType: "user",
      result: "failure",
      requestId,
    });
    return errorResponse(error, requestId);
  }
}
