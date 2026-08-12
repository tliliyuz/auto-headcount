import {
  errorResponse,
  getAuthContext,
  jsonResponse,
  newRequestId,
  readSessionToken,
  writeAudit,
} from "../../../lib/identity/auth-http";
import { authorizeOrForbidden } from "../../../lib/identity/authz.mjs";
import { parsePagination } from "../../../lib/server/pagination.mjs";
import { listSyncRuns } from "../../../lib/sources/source-read-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 同步批次列表（只读，RBAC operations/admin）。 */
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
      action: "sync-runs.list",
      resourceType: "sync_run",
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
    const result = await listSyncRuns(client, {
      status: url.searchParams.get("status") ?? undefined,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser.user.id,
      action: "sync-runs.list",
      resourceType: "sync_run",
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
    console.error(`[sync-runs.list] requestId=${requestId}`, error);
    return errorResponse(error, requestId);
  }
}
