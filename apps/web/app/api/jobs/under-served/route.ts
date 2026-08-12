import {
  errorResponse,
  getAuthContext,
  jsonResponse,
  newRequestId,
  readSessionToken,
  writeAudit,
} from "../../../../lib/identity/auth-http";
import { authorizeOrForbidden } from "../../../../lib/identity/authz.mjs";
import { listUnderServedJobs } from "../../../../lib/jobs/job-read-repository.mjs";
import { parsePagination } from "../../../../lib/server/pagination.mjs";
import { getDb } from "../../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/**
 * 沉睡职位列表（只读，RBAC operations/admin）。
 * 睡眠规则在仓储 SQL 中权威执行（7/30 天含边界、active、零推荐）。
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { service, repo } = getAuthContext();

  const token = readSessionToken(request);
  if (!token) {
    return jsonResponse(
      { code: "unauthorized", message: "未登录或会话已失效" },
      401,
    );
  }
  const sessionUser = await service.getSessionUser(token);
  if (!sessionUser) {
    return jsonResponse(
      { code: "unauthorized", message: "未登录或会话已失效" },
      401,
    );
  }

  const forbidden = authorizeOrForbidden(sessionUser, ALLOWED_ROLES);
  if (forbidden) {
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser.user.id,
      action: "jobs.list",
      resourceType: "job",
      result: "denied",
      requestId,
    });
    return forbidden;
  }

  const url = new URL(request.url);
  const parsed = parsePagination(url);
  if (!parsed.ok) {
    return jsonResponse({ code: "invalid_request", message: parsed.reason }, 400);
  }

  const { client } = getDb();
  try {
    const result = await listUnderServedJobs(client, {
      category: url.searchParams.get("category") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser.user.id,
      action: "jobs.list",
      resourceType: "job",
      result: "success",
      requestId,
      metadata: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      },
    });
    return jsonResponse({
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      total_pages: result.totalPages,
      list: result.list,
    });
  } catch (error) {
    console.error(`[jobs.list] requestId=${requestId}`, error);
    return errorResponse(error, requestId);
  }
}
