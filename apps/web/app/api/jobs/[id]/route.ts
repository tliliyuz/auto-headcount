import { jsonResponse } from "../../../../lib/identity/auth-http";
import { withAudit } from "../../../../lib/server/with-audit";
import { getJobById } from "../../../../lib/jobs/job-read-repository.mjs";
import { parseJobIdFromPathname } from "../../../../lib/server/job-id.mjs";
import { getDb } from "../../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];

/**
 * 职位详情（只读，RBAC operations/admin）。
 * 会话/RBAC/审计由 withAudit 收口；id 从 URL pathname 解析（withAudit 不把
 * vinext 的 `params` 传入 handler，见 job-id.mjs）。非 UUID → 400；查无 → 404。
 * 审计元数据白名单仅 `found`，绝不包含 JD 正文（docs/06 §4.3）。
 */
export const GET = withAudit(
  {
    action: "jobs.detail",
    resourceType: "job",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["found"],
  },
  async (ctx) => {
    const id = parseJobIdFromPathname(new URL(ctx.request.url).pathname);
    if (!id) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "职位 id 必须是 UUID" },
          400,
        ),
      };
    }

    const { client } = getDb();
    const job = await getJobById(client, id);
    if (!job) {
      return {
        response: jsonResponse(
          { code: "not_found", message: "职位不存在或已下架" },
          404,
        ),
      };
    }

    return {
      response: jsonResponse(job),
      audit: { resourceId: job.id, metadata: { found: true } },
    };
  },
);
