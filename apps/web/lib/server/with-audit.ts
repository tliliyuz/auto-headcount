import {
  errorResponse,
  getAuthContext,
  jsonResponse,
  newRequestId,
  readSessionToken,
  writeAudit,
} from "../identity/auth-http";
import { authorizeOrForbidden } from "../identity/authz.mjs";
import { planAudit } from "./audit.mjs";
import { passwordChangeBlockResponse } from "./with-audit-gate.mjs";

/** 中间件向 handler 提供的上下文：requestId + 原始请求 + 已解析会话（allowedRoles 时非 null）。 */
export type AuditRouteContext = {
  requestId: string;
  request: Request;
  sessionUser:
    | {
        user: { id: string; username: string; displayName: string; status: string };
        roles: string[];
        passwordChangeRequired: boolean;
      }
    | null;
};

export type AuditSpec = {
  action: string;
  resourceType?: string;
  /** 存在时强制会话 + RBAC：无会话 401（不审计）、角色不符 403 + denied 审计。 */
  allowedRoles?: string[];
  /** 成功审计元数据白名单键，其余键被剔除（防误记敏感字段）。 */
  auditMetadataKeys?: string[];
};

export type AuditOutcome = {
  response: Response;
  audit?: { resourceId?: string | null; metadata?: Record<string, unknown> };
};

/** 尽力捕获客户端 IP：cf-connecting-ip → x-forwarded-for 首段 → null。 */
export function resolveClientIp(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * 通用审计中间件：统一 request_id / IP / actor 解析与结果推导，
 * 保证受保护路由的每次访问都落审计（含未预期异常写 failure，收口 500 无审计缺口）。
 * handler 返回 { response, audit? }；成功审计元数据只保留 spec.auditMetadataKeys 白名单键。
 * 有 allowedRoles 时先执行首登强制改密门禁：会话 passwordChangeRequired 则 403 拒绝（denied 审计）。
 */
export function withAudit(
  spec: AuditSpec,
  handler: (ctx: AuditRouteContext) => Promise<AuditOutcome>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = newRequestId();
    const { service, repo } = getAuthContext();

    const token = readSessionToken(request);
    const sessionUser = token ? await service.getSessionUser(token) : null;

    if (spec.allowedRoles && !sessionUser) {
      return jsonResponse(
        { code: "unauthorized", message: "未登录或会话已失效" },
        401,
      );
    }

    if (spec.allowedRoles) {
      const passwordChangeBlock = passwordChangeBlockResponse(
        sessionUser,
        spec.allowedRoles,
      );
      if (passwordChangeBlock) {
        await writeAudit(
          repo,
          planAudit({
            requestId,
            actor: sessionUser?.user ?? null,
            action: spec.action,
            resourceType: spec.resourceType,
            outcome: "denied",
            ipAddress: resolveClientIp(request),
          }),
        );
        return passwordChangeBlock;
      }

      const forbidden = authorizeOrForbidden(sessionUser, spec.allowedRoles);
      if (forbidden) {
        await writeAudit(
          repo,
          planAudit({
            requestId,
            actor: sessionUser.user,
            action: spec.action,
            resourceType: spec.resourceType,
            outcome: "denied",
            ipAddress: resolveClientIp(request),
          }),
        );
        return forbidden;
      }
    }

    const ctx: AuditRouteContext = { requestId, request, sessionUser };
    try {
      const { response, audit } = await handler(ctx);
      await writeAudit(
        repo,
        planAudit({
          requestId,
          actor: sessionUser?.user ?? null,
          action: spec.action,
          resourceType: spec.resourceType,
          outcome: "success",
          metadataKeys: spec.auditMetadataKeys,
          audit,
          ipAddress: resolveClientIp(request),
        }),
      );
      return response;
    } catch (error) {
      console.error(`[${spec.action}] requestId=${requestId}`, error);
      await writeAudit(
        repo,
        planAudit({
          requestId,
          actor: sessionUser?.user ?? null,
          action: spec.action,
          resourceType: spec.resourceType,
          outcome: "failure",
          ipAddress: resolveClientIp(request),
        }),
      );
      return errorResponse(error, requestId);
    }
  };
}
