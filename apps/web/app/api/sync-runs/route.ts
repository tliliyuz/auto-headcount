import { jsonResponse } from "../../../lib/identity/auth-http";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { listSyncRuns } from "../../../lib/sources/source-read-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 同步批次列表（只读，RBAC operations/admin）。 */
export const GET = withAudit(
  {
    action: "sync-runs.list",
    resourceType: "sync_run",
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
    const result = await listSyncRuns(client, {
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
