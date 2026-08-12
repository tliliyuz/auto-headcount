/**
 * 业务只读端点授权判定：命中任一允许角色即放行（返回 null），否则返回统一 403 包络。
 *
 * 判定语义与 identity-service.authorize 一致（roles 命中 allowedRoles 任一）；
 * 保持纯函数便于单元测试，不自建 IdentityService 实例（构造需要仓储）。
 * 调用方负责先完成会话校验（getSessionUser），此函数只做角色授权。
 */
export function authorizeOrForbidden(
  user,
  allowedRoles,
  { message = "没有权限访问该资源" } = {},
) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  if (roles.some((role) => allowedRoles.includes(role))) return null;
  return new Response(JSON.stringify({ code: "forbidden", message }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
