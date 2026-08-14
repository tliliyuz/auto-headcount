import { jsonResponse } from "../../../lib/identity/auth-http";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { listAuditLogs } from "../../../lib/identity/audit-read-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];
const ACTOR_TYPES = new Set(["user", "system"]);
const RESULTS = new Set(["success", "failure", "denied"]);

/** 审计日志查询（只读，RBAC operations/admin）。写入已按动作白名单收敛，元数据读回安全。 */
export const GET = withAudit(
  {
    action: "audit-logs.list",
    resourceType: "audit_log",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["page", "pageSize", "total"],
  },
  async (ctx) => {
    const url = new URL(ctx.request.url);
    const parsed = parsePagination(url, { defaultPageSize: 50 });
    if (!parsed.ok) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: parsed.reason },
          400,
        ),
      };
    }

    const action = url.searchParams.get("action") ?? undefined;
    const actorType = url.searchParams.get("actor_type") ?? undefined;
    const result = url.searchParams.get("result") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    if (
      (actorType !== undefined && !ACTOR_TYPES.has(actorType)) ||
      (result !== undefined && !RESULTS.has(result))
    ) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "过滤参数不合法" },
          400,
        ),
      };
    }

    const { client } = getDb();
    const logs = await listAuditLogs(client, {
      action,
      actorType,
      result,
      q,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    return {
      response: jsonResponse({
        total: logs.total,
        page: logs.page,
        page_size: logs.pageSize,
        total_pages: logs.totalPages,
        list: logs.list,
      }),
      audit: {
        metadata: {
          page: logs.page,
          pageSize: logs.pageSize,
          total: logs.total,
        },
      },
    };
  },
);
