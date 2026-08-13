import { jsonResponse } from "../../../lib/identity/auth-http";
import { listMatches } from "../../../lib/jobs/match-read-repository.mjs";
import { getDb } from "../../../lib/server/db";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { withAudit } from "../../../lib/server/with-audit";

/**
 * 匹配结果列表（只读，M2 审核页）：分页包络，可按 job_id/band/status 过滤。
 * 白名单投影：候选人打码名 + 摘要，**不投影 portal_url/联系方式/原始载荷**。
 */
const handler = withAudit(
  {
    action: "matches.list",
    resourceType: "match",
    allowedRoles: ["operations", "admin"],
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
    const result = await listMatches(client, {
      jobId: url.searchParams.get("job_id") ?? undefined,
      band: url.searchParams.get("band") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    return {
      response: jsonResponse(
        {
          total: result.total,
          page: result.page,
          page_size: result.pageSize,
          total_pages: result.totalPages,
          list: result.list,
        },
        200,
      ),
      audit: {
        metadata: {
          page: parsed.page,
          pageSize: parsed.pageSize,
          total: result.total,
        },
      },
    };
  },
);

export const GET = handler;
