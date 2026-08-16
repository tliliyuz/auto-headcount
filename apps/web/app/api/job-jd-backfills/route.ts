import { jsonResponse } from "../../../lib/identity/auth-http";
import { withAudit } from "../../../lib/server/with-audit";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { listJobJdBackfills } from "../../../lib/jobs/browser-job-jd-backfill-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** JD 回填台账列表（只读，RBAC operations/admin）：outcome/职位标题/错误码/时间。 */
export const GET = withAudit(
  {
    action: "job-jd-backfills.list",
    resourceType: "job_jd_backfill",
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
    const rawOutcome = url.searchParams.get("outcome") ?? undefined;
    const outcome =
      rawOutcome === "filled" || rawOutcome === "no_provider_jd" || rawOutcome === "failed"
        ? rawOutcome
        : undefined;

    const { client } = getDb();
    const result = await listJobJdBackfills(client, {
      outcome,
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
