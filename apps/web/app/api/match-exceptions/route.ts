import { jsonResponse } from "../../../lib/identity/auth-http";
import { listMatchExceptions } from "../../../lib/jobs/match-exception-repository.mjs";
import { getDb } from "../../../lib/server/db";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { withAudit } from "../../../lib/server/with-audit";

const handler = withAudit(
  {
    action: "match-exceptions.list",
    resourceType: "match_exception",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["page", "pageSize", "total", "type"],
  },
  async (ctx) => {
    const url = new URL(ctx.request.url);
    const parsed = parsePagination(url);
    const type = url.searchParams.get("type") ?? "all";
    if (!parsed.ok || !["all", "filter", "scoring"].includes(type)) {
      return { response: jsonResponse({ code: "invalid_request", message: parsed.ok ? "type 非法" : parsed.reason }, 400) };
    }
    const { client } = getDb();
    const result = await listMatchExceptions(client, { type: type as "all" | "filter" | "scoring", page: parsed.page, pageSize: parsed.pageSize });
    return {
      response: jsonResponse({ total: result.total, page: result.page, page_size: result.pageSize, total_pages: result.totalPages, list: result.list }, 200),
      audit: { metadata: { page: parsed.page, pageSize: parsed.pageSize, total: result.total, type } },
    };
  },
);

export const GET = handler;
