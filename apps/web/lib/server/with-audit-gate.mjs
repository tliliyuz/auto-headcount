/**
 * withAudit 的准入判定纯函数（无 DB 依赖，可单测）。
 *
 * 首登强制改密门禁：有 `allowedRoles` 的业务只读端点要求会话必须已完成改密，
 * 否则返回 403 `password_change_required`，阻止一次性凭证/重置后账号在改密前
 * 访问业务功能（docs/07「首次登录强制改密，改密前不能使用业务功能」）。
 * 认证路由（login/logout/me/password）不经过 withAudit，不受此门禁影响。
 */
export function passwordChangeBlockResponse(sessionUser, allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return null;
  if (sessionUser?.passwordChangeRequired !== true) return null;
  return new Response(
    JSON.stringify({
      code: "password_change_required",
      message: "首次登录需先修改口令",
    }),
    {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
