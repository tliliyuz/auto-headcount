import {
  getAuthContext,
  jsonResponse,
  readSessionToken,
} from "../../../../lib/identity/auth-http";

export async function GET(request: Request): Promise<Response> {
  const { service } = getAuthContext();
  const token = readSessionToken(request);
  if (!token) {
    return jsonResponse(
      { code: "unauthorized", message: "未登录或会话已失效" },
      401,
    );
  }
  const sessionUser = await service.getSessionUser(token);
  if (!sessionUser) {
    return jsonResponse(
      { code: "unauthorized", message: "未登录或会话已失效" },
      401,
    );
  }
  return jsonResponse({
    user: sessionUser.user,
    roles: sessionUser.roles,
    passwordChangeRequired: sessionUser.passwordChangeRequired,
  });
}
