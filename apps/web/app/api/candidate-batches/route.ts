import { jsonResponse } from "../../../lib/identity/auth-http";
import { createBrowserCandidateBatchRepository } from "../../../lib/jobs/browser-candidate-repository.mjs";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 候选人采集批次列表（只读，RBAC operations/admin）：数据源页「候选人批次」tab 数据源。 */
export const GET = withAudit(
  {
    action: "candidate-batches.list",
    resourceType: "candidate_collection",
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
    const result = await createBrowserCandidateBatchRepository(client).listBatches({
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
