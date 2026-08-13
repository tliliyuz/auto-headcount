import { jsonResponse } from "../../../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../../../lib/identity/csrf.mjs";
import { updateMatchStatus } from "../../../../../lib/jobs/match-repository.mjs";
import { getDb } from "../../../../../lib/server/db";
import { parseMatchIdFromPathname } from "../../../../../lib/server/match-id.mjs";
import { withAudit } from "../../../../../lib/server/with-audit";

/**
 * 人工审核匹配（写路由，M2）：`approve`/`reject` 把匹配从 `generated` 流转到
 * `approved`/`rejected`（docs/03 §9）。已审核的匹配返回 409（不重复流转）。
 * 只有 `approved` 的匹配可进入触达活动（M3 门禁）。
 */
const handler = withAudit(
  {
    action: "matches.review",
    resourceType: "match",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["decision", "status"],
  },
  async (ctx) => {
    const id = parseMatchIdFromPathname(new URL(ctx.request.url).pathname);
    if (!id) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "id 必须是 UUID" },
          400,
        ),
      };
    }

    let body: unknown;
    try {
      body = await ctx.request.json();
    } catch {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "请求体必须是 JSON" },
          400,
        ),
      };
    }
    const decision = (body as { decision?: unknown })?.decision;
    if (decision !== "approve" && decision !== "reject") {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "decision 必须是 approve 或 reject" },
          400,
        ),
      };
    }
    const status = decision === "approve" ? "approved" : "rejected";

    const { client } = getDb();
    const updated = await updateMatchStatus(client, { id, status });
    if (!updated) {
      return {
        response: jsonResponse(
          { code: "conflict", message: "匹配已审核，不可重复流转" },
          409,
        ),
      };
    }
    return {
      response: jsonResponse({ id, status }, 200),
      audit: { resourceId: id, metadata: { decision, status } },
    };
  },
);

/** 写路由先做 CSRF 同源校验（跨源 403，不落审计），再进 withAudit。 */
export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
