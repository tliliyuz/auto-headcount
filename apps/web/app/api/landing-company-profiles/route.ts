import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { upsertCompanyLandingProfile } from "../../../lib/landing/company-profile-repository.mjs";
import { getDb } from "../../../lib/server/db";
import { withAudit } from "../../../lib/server/with-audit";

/**
 * 运营侧维护公司隐性信息档案（会话 + RBAC operations|admin）：按公司名 upsert
 * 行业定位/公司体量/对标企业/办公地点（脱敏 teaser，不在落地页直接显示公司名，ADR-006）。
 */
const handler = withAudit(
  {
    action: "landing.company_profile.upsert",
    resourceType: "company_landing_profile",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["companyName"],
  },
  async (ctx) => {
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
    const { companyName, industryPositioning, companyScale, benchmarks, officeLocation } =
      (body ?? {}) as Record<string, unknown>;
    if (typeof companyName !== "string" || companyName.trim() === "") {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "companyName 必填" },
          400,
        ),
      };
    }
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;

    const { client } = getDb();
    const profile = await upsertCompanyLandingProfile(client, {
      companyName: companyName.trim(),
      industryPositioning: text(industryPositioning),
      companyScale: text(companyScale),
      benchmarks: text(benchmarks),
      officeLocation: text(officeLocation),
    });
    return {
      response: jsonResponse(
        {
          companyName: profile.companyName,
          industryPositioning: profile.industryPositioning,
          companyScale: profile.companyScale,
          benchmarks: profile.benchmarks,
          officeLocation: profile.officeLocation,
        },
        200,
      ),
      audit: { resourceId: profile.id, metadata: { companyName: profile.companyName } },
    };
  },
);

export const PUT = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
