import { jsonResponse } from "../../../../lib/identity/auth-http";
import { withAudit } from "../../../../lib/server/with-audit";
import { listUnderServedJobs } from "../../../../lib/jobs/job-read-repository.mjs";
import { parsePagination } from "../../../../lib/server/pagination.mjs";
import { getDb } from "../../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/**
 * 沉睡职位列表（只读，RBAC operations/admin）。
 * 会话/RBAC/审计由通用中间件 withAudit 收口；睡眠规则在仓储 SQL 中权威执行（7/30 天含边界、active、零推荐）。
 */
export const GET = withAudit(
  {
    action: "jobs.list",
    resourceType: "job",
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
    const result = await listUnderServedJobs(client, {
      category: url.searchParams.get("category") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
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
