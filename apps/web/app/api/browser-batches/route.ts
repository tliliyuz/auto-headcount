import { jsonResponse } from "../../../lib/identity/auth-http";
import { createBrowserJobBatchRepository } from "../../../lib/jobs/browser-job-batch-repository.mjs";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 浏览器采集批次列表（只读，RBAC operations/admin）：前端「最近采集批次」面板数据源。 */
export const GET = withAudit(
  {
    action: "browser-batches.list",
    resourceType: "browser_collection",
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
    const result = await createBrowserJobBatchRepository(client).listBatches({
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
