import { jsonResponse } from "../../../lib/identity/auth-http";
import { withAudit } from "../../../lib/server/with-audit";
import { listCandidates } from "../../../lib/jobs/candidate-read-repository.mjs";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/**
 * 候选人池列表（只读，RBAC operations/admin）。
 * 候选人画像属敏感业务：真实姓名仅在内部运营会话下返回，审计元数据只存页码/条数/总数，
 * 不含姓名/联系方式。匹配状态（待匹配/已匹配/已审核）由仓储从 matches 推导。
 */
export const GET = withAudit(
  {
    action: "candidates.list",
    resourceType: "candidate",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["page", "pageSize", "total"],
  },
  async (ctx) => {
    const url = new URL(ctx.request.url);
    const parsed = parsePagination(url);
    if (!parsed.ok) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: parsed.reason },
          400,
        ),
      };
    }

    const { client } = getDb();
    const result = await listCandidates(client, {
      q: url.searchParams.get("q") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    return {
      response: jsonResponse({
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
        total_pages: result.totalPages,
        list: result.list,
      }),
      audit: {
        metadata: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
        },
      },
    };
  },
);
