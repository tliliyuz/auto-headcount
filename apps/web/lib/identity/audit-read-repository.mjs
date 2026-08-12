/**
 * 审计只读仓储：审计日志查询（追加写，应用角色不可更新；删除仅保留任务）。
 *
 * 元数据在写入时已按动作白名单收敛（见 lib/server/audit.mjs），读回安全；
 * 投影为内部运营 API 白名单，不含 Secret、Cookie、令牌、手机号、邮箱、简历正文等敏感正文。
 * actor_id 对 users 是无外键的语义引用，审计事实不随用户删除丢失（03-data-model §5.5）。
 */
export async function listAuditLogs(
  sql,
  { action, actorType, result, page = 1, pageSize = 50 } = {},
) {
  const where = sql`
    1 = 1
    ${action ? sql` and action = ${action}` : sql``}
    ${actorType ? sql` and actor_type = ${actorType}` : sql``}
    ${result ? sql` and result = ${result}` : sql``}
  `;

  const [{ total }] = await sql`
    select count(*)::int as total
    from audit_logs
    where ${where}
  `;

  const list = await sql`
    select
      id,
      occurred_at as "occurredAt",
      actor_type as "actorType",
      actor_id as "actorId",
      action,
      resource_type as "resourceType",
      resource_id as "resourceId",
      result,
      request_id as "requestId",
      metadata,
      ip_address as "ipAddress"
    from audit_logs
    where ${where}
    order by occurred_at desc, id desc
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `;

  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    list,
  };
}
