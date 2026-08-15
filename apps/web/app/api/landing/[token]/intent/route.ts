import { jsonResponse } from "../../../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../../../lib/identity/csrf.mjs";
import {
  LANDING_INTENT_OPTIONS,
  LANDING_LINK_UNAVAILABLE_CODE,
  submitLandingIntent,
} from "../../../../../lib/landing/landing-intent-service.mjs";
import { getDb } from "../../../../../lib/server/db";
import { getWorkerEnv } from "../../../../../lib/server/runtime-env";
import { withAudit } from "../../../../../lib/server/with-audit";

const INTENT_OPTION_SET = new Set<string>(LANDING_INTENT_OPTIONS);

/**
 * 公开侧意向提交（独立身份域，令牌门禁，无会话）：A/B/C 或退订 + 联系方式。
 * 联系方式规则（2026-08-16 放开）：仅选项 A（有兴趣请联系我）必填，B/C/退订可无联系方式提交。
 * 意向真源落库（联系方式信封加密，无联系方式时列为空）→ notifier 尽力投递（失败不影响意向）→ 成功/失败审计。
 * 审计元数据白名单仅 responseId/deduplicated/notifyStatus，**不含联系方式正文**（ADR-006）。
 */
const handler = withAudit(
  {
    action: "landing.intent.submit",
    resourceType: "landing_intent",
    auditMetadataKeys: ["responseId", "deduplicated", "notifyStatus"],
  },
  async (ctx) => {
    const token = parseTokenFromPathname(new URL(ctx.request.url).pathname);
    if (!token) {
      return {
        response: jsonResponse(
          { code: LANDING_LINK_UNAVAILABLE_CODE, message: "落地页链接不可用" },
          404,
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
    const { option, phone, email } = (body ?? {}) as Record<string, unknown>;
    if (typeof option !== "string" || !INTENT_OPTION_SET.has(option)) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "意向选项不合法" },
          400,
        ),
      };
    }
    const hasPhone = typeof phone === "string" && phone.trim() !== "";
    const hasEmail = typeof email === "string" && email.trim() !== "";
    // 2026-08-16 放开：仅选项 A（有兴趣请联系我）必填联系方式；B/C/退订可无联系方式提交。
    if (option === "A" && !hasPhone && !hasEmail) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "选择「有兴趣，请联系我」需要留下联系方式" },
          400,
        ),
      };
    }

    const env = getWorkerEnv();
    // workerd 运行时 `process` 可能不存在（runtime-env.ts 同款守卫）：Worker 绑定优先，
    // 其次 Node 上下文 process.env（测试/脚本）。
    const procEnv: Record<string, string | undefined> =
      typeof process !== "undefined" ? process.env : {};
    const encryptionKey =
      typeof env.APP_ENCRYPTION_KEY === "string"
        ? env.APP_ENCRYPTION_KEY
        : procEnv.APP_ENCRYPTION_KEY;
    const encryptionKeyVersion =
      typeof env.APP_ENCRYPTION_KEY_VERSION === "string"
        ? env.APP_ENCRYPTION_KEY_VERSION
        : procEnv.APP_ENCRYPTION_KEY_VERSION;
    if (!encryptionKey || !encryptionKeyVersion) {
      return {
        response: jsonResponse(
          { code: "encryption_config_required", message: "服务端加密配置缺失" },
          503,
        ),
      };
    }
    const config = {
      encryptionKey,
      encryptionKeyVersion,
      channel:
        (typeof env.NOTIFIER_CHANNEL === "string"
          ? env.NOTIFIER_CHANNEL
          : procEnv.NOTIFIER_CHANNEL) ?? undefined,
      feishuWebhookUrl:
        (typeof env.FEISHU_WEBHOOK_URL === "string"
          ? env.FEISHU_WEBHOOK_URL
          : procEnv.FEISHU_WEBHOOK_URL) ?? undefined,
      feishuWebhookSecret:
        (typeof env.FEISHU_WEBHOOK_SECRET === "string"
          ? env.FEISHU_WEBHOOK_SECRET
          : procEnv.FEISHU_WEBHOOK_SECRET) ?? undefined,
    };

    const { client } = getDb();
    const result = await submitLandingIntent(client, {
      token,
      option,
      phone: hasPhone ? phone : undefined,
      email: hasEmail ? email : undefined,
      consentSnapshot: {
        scope: "本次职位沟通，可随时拒绝后续联系",
        canRefuse: true,
        language: "zh-CN",
      },
      config,
      now: new Date(),
    });

    if (!result.ok) {
      return {
        response: jsonResponse(
          { code: result.code, message: "落地页链接不可用" },
          404,
        ),
      };
    }
    return {
      response: jsonResponse(
        {
          responseId: result.responseId,
          option: result.option,
          deduplicated: result.deduplicated,
        },
        200,
      ),
      audit: {
        resourceId: result.responseId,
        metadata: {
          responseId: result.responseId,
          deduplicated: result.deduplicated,
          notifyStatus: result.notifyStatus,
        },
      },
    };
  },
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};

function parseTokenFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  // /api/landing/:token/intent → 令牌在倒数第二段（最后一段是动作 "intent"）
  const token = segments[segments.length - 2];
  return token ? decodeURIComponent(token) : null;
}
