import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { withAudit } from "../../../lib/server/with-audit";

const handler = withAudit(
  {
    action: "match-tasks.deprecated",
    resourceType: "match",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: [],
  },
  async () => ({
    response: jsonResponse(
      { code: "manual_match_disabled", message: "正常匹配已改为系统自动编排" },
      410,
    ),
  }),
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
