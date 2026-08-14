import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import {
  createLandingLink,
} from "../../../lib/landing/landing-link-repository.mjs";
import {
  generateLandingToken,
  hashLandingToken,
} from "../../../lib/landing/landing-token.mjs";
import { getDb } from "../../../lib/server/db";
import { withAudit } from "../../../lib/server/with-audit";

const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_EXPIRES_IN_DAYS = 90;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 运营侧建链（会话 + RBAC operations|admin）：为「职位 × 候选人」生成落地页链接。
 * 令牌为高熵随机、数据库只存哈希；明文令牌只在本次响应返回给运营一次（docs/06 §3、ADR-006）。
 * 生产门禁注记：完整 M4 中建链仅对人工审核通过的匹配开放（随 campaigns 收口）。
 */
const handler = withAudit(
  {
    action: "landing.link.create",
    resourceType: "landing_link",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["jobId", "candidateId"],
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
    const { jobId, candidateId, expiresInDays } = (body ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof jobId !== "string" ||
      typeof candidateId !== "string" ||
      !UUID_PATTERN.test(jobId) ||
      !UUID_PATTERN.test(candidateId)
    ) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "jobId 与 candidateId 必须为 UUID" },
          400,
        ),
      };
    }
    const days =
      Number.isInteger(expiresInDays) && (expiresInDays as number) >= 1
        ? Math.min(expiresInDays as number, MAX_EXPIRES_IN_DAYS)
        : DEFAULT_EXPIRES_IN_DAYS;

    const { client } = getDb();
    const [ref] = await client`
      select
        (select 1 from jobs where id = ${jobId}) as job_exists,
        (select 1 from candidates where id = ${candidateId}) as candidate_exists
    `;
    if (!ref.job_exists || !ref.candidate_exists) {
      return {
        response: jsonResponse(
          { code: "not_found", message: "职位或候选人不存在" },
          404,
        ),
      };
    }

    const token = generateLandingToken();
    const link = await createLandingLink(client, {
      jobId,
      candidateId,
      tokenHash: hashLandingToken(token),
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      createdBy: ctx.sessionUser?.user.id ?? null,
    });
    const origin = new URL(ctx.request.url).origin;

    return {
      response: jsonResponse(
        { linkId: link.id, url: `${origin}/landing/${token}` },
        201,
      ),
      audit: { resourceId: link.id, metadata: { jobId, candidateId } },
    };
  },
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
