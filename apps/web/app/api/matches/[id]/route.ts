import { jsonResponse } from "../../../../lib/identity/auth-http";
import { getMatchById } from "../../../../lib/jobs/match-read-repository.mjs";
import { getDb } from "../../../../lib/server/db";
import { parseMatchIdFromPathname } from "../../../../lib/server/match-id.mjs";
import { withAudit } from "../../../../lib/server/with-audit";

/**
 * 匹配详情（只读）：返回匹配 + 维度分（match_dimensions）。
 * 审计元数据白名单仅 `found`（不含匹配正文/候选人敏感字段）。
 */
const handler = withAudit(
  {
    action: "matches.detail",
    resourceType: "match",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["found"],
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
    const { client } = getDb();
    const match = await getMatchById(client, id);
    if (!match) {
      return {
        response: jsonResponse(
          { code: "not_found", message: "匹配不存在" },
          404,
        ),
      };
    }
    return {
      response: jsonResponse(match, 200),
      audit: { resourceId: id, metadata: { found: true } },
    };
  },
);

export const GET = handler;
