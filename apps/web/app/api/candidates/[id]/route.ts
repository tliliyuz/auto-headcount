import { jsonResponse } from "../../../../lib/identity/auth-http";
import { withAudit } from "../../../../lib/server/with-audit";
import { getWorkerEnv } from "../../../../lib/server/runtime-env";
import { getCandidateById } from "../../../../lib/jobs/candidate-read-repository.mjs";
import { getDb } from "../../../../lib/server/db";

const ALLOWED_ROLES = ["operations", "admin"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 从 `/api/candidates/{id}` 路径解析候选人 UUID；缺 id 或非 UUID → null（路由映射 400）。 */
function parseCandidateIdFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id || !UUID_PATTERN.test(id)) return null;
  return id.toLowerCase();
}

/**
 * 候选人详情（只读，RBAC operations/admin）。
 * 候选人画像属敏感业务：真实姓名仅内部运营会话下返回；工作经历从 raw_records 加密载荷
 * 解密返回（联系方式/简历正文仍在白名单外，绝不外发）。审计元数据白名单仅 `found`。
 */
export const GET = withAudit(
  {
    action: "candidates.detail",
    resourceType: "candidate",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["found"],
  },
  async (ctx) => {
    const id = parseCandidateIdFromPathname(new URL(ctx.request.url).pathname);
    if (!id) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "候选人 id 必须是 UUID" },
          400,
        ),
      };
    }

    const env = getWorkerEnv();
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

    const { client } = getDb();
    const detail = await getCandidateById(client, id, {
      encryption: { key: encryptionKey, keyVersion: encryptionKeyVersion },
    });
    if (!detail) {
      return {
        response: jsonResponse(
          { code: "candidate_not_found", message: "候选人不存在" },
          404,
        ),
      };
    }
    return {
      response: jsonResponse(detail),
      audit: {
        metadata: { found: true },
      },
    };
  },
);
