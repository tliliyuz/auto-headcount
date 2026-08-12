/** withAudit 首登强制改密门禁判定：会话需改密且有 allowedRoles 时返回 403 响应，否则 null。 */
export function passwordChangeBlockResponse(
  sessionUser: { passwordChangeRequired: boolean } | null,
  allowedRoles?: string[],
): Response | null;
