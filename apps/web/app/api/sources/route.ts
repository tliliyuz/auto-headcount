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
import { listSources } from "../../../lib/sources/source-read-repository.mjs";
import { getDb } from "../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/** 数据源连接列表（只读，RBAC operations/admin），附每条最新同步摘要。 */
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
      action: "sources.list",
      resourceType: "source_connection",
      result: "denied",
      requestId,
    });
    return forbidden;
  }

  const parsed = parsePagination(new URL(request.url), {
    defaultPageSize: 50,
  });
  if (!parsed.ok) {
    return jsonResponse({ code: "invalid_request", message: parsed.reason }, 400);
  }

  const { client } = getDb();
  try {
    const result = await listSources(client, {
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser.user.id,
      action: "sources.list",
      resourceType: "source_connection",
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
    console.error(`[sources.list] requestId=${requestId}`, error);
    return errorResponse(error, requestId);
  }
}
