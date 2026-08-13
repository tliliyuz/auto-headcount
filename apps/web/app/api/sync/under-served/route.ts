import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../../lib/identity/csrf.mjs";
import { createAsyncTaskRepository } from "../../../../lib/jobs/async-task-repository.mjs";
import { getDb } from "../../../../lib/server/db";
import { withAudit } from "../../../../lib/server/with-audit";

const ALLOWED_ROLES = ["operations", "admin"];
const TASK_KIND_SYNC = "under_served_sync";

/**
 * 手动触发同步（写路由）：入队一个立即执行的 `under_served_sync` 任务（async_tasks），
 * 由调度 tick（dev scheduler / 生产 scheduler 服务）认领执行——不做长请求内同步。
 * 返回 202 accepted + taskId；会话 + RBAC operations/admin + 写审计（withAudit）。
 * payload 留空，调度器按其环境（resolveSyncSource）解析同步源与 MCP 配置。
 */
const handler = withAudit(
  {
    action: "sync.trigger",
    resourceType: "sync_run",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["taskId"],
  },
  async () => {
    const { client } = getDb();
    const taskRepo = createAsyncTaskRepository(client);
    const taskId = await taskRepo.enqueueTask({
      kind: TASK_KIND_SYNC,
      idempotencyKey: `under-served-sync:manual:${randomUUID()}`,
      payload: {},
      scheduledAt: new Date(),
    });
    return {
      response: jsonResponse({ accepted: true, taskId }, 202),
      audit: { metadata: { taskId } },
    };
  },
);

/** 写路由先做 CSRF 同源校验（跨源 403，不落审计），再进 withAudit。 */
export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
