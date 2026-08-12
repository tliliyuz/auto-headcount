import { jsonResponse } from "../../../lib/identity/auth-http";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { listSources } from "../../../lib/sources/source-read-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 数据源连接列表（只读，RBAC operations/admin），附每条最新同步摘要。 */
export const GET = withAudit(
  {
    action: "sources.list",
    resourceType: "source_connection",
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

    const { client } = getDb();
    const result = await listSources(client, {
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
