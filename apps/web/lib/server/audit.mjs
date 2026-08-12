/**
 * 通用审计条目规划：由路由声明的审计规格与执行结果推导标准审计条目。
 *
 * 保证：
 * - 结果只允许 success/denied/failure 白名单（unauthorized 由中间件直接跳过，避免扫描器洪泛）；
 * - 元数据只保留路由声明的白名单键（pickMetadata），防止未来路由误记敏感正文；
 * - actor 缺失（未预期异常、匿名上下文）时 actorId 回落 null，审计事实不因 actor 缺失丢失。
 */

const AUDIT_OUTCOMES = new Set(["success", "denied", "failure"]);

/** 从元数据对象中只取出白名单键；非对象安全回落为空对象。 */
export function pickMetadata(metadata, keys) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const out = {};
  for (const key of keys) {
    if (key in metadata) out[key] = metadata[key];
  }
  return out;
}

/**
 * @param {object} input
 * @param {string|null} [input.requestId]
 * @param {{id: string}|null} [input.actor] 已解析的会话用户；无会话时为 null
 * @param {string} input.action 审计动作（如 jobs.list）
 * @param {string|null} [input.resourceType]
 * @param {"success"|"denied"|"failure"} input.outcome
 * @param {string[]} [input.metadataKeys] 成功审计元数据白名单键
 * @param {{resourceId?: string|null, metadata?: Record<string, unknown>}} [input.audit] handler 声明的成功审计细节
 * @param {string|null} [input.ipAddress] 尽力捕获的客户端 IP
 * @returns {import("../identity/auth-repository.mjs").AuditEntry|null} 非法结果返回 null（不写审计）
 */
export function planAudit({
  requestId,
  actor,
  action,
  resourceType,
  outcome,
  metadataKeys = [],
  audit,
  ipAddress = null,
}) {
  if (!AUDIT_OUTCOMES.has(outcome)) return null;
  return {
    actorType: "user",
    actorId: actor?.id ?? null,
    action,
    resourceType: resourceType ?? null,
    resourceId: outcome === "success" ? (audit?.resourceId ?? null) : null,
    result: outcome,
    requestId: requestId ?? null,
    ipAddress: ipAddress ?? null,
    metadata:
      outcome === "success" ? pickMetadata(audit?.metadata, metadataKeys) : {},
  };
}
