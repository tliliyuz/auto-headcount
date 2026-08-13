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
 *
 * 手动触发去重：`enqueueTaskIfIdle` 保证同 kind 至多一个活跃（pending/running）任务，
 * 重复点击不重复入队（此前 5 次点击 = 5 个并发任务同时打 MCP 导致限流/假死）。
 * 被拦截时返回 `accepted:false + deduplicated:true` + 既有活跃任务 id（供前端跟踪状态）。
 */
const handler = withAudit(
  {
    action: "sync.trigger",
    resourceType: "sync_run",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["taskId", "deduplicated"],
  },
  async () => {
    const { client } = getDb();
    const taskRepo = createAsyncTaskRepository(client);
    const taskId = await taskRepo.enqueueTaskIfIdle({
      kind: TASK_KIND_SYNC,
      idempotencyKey: `under-served-sync:manual:${randomUUID()}`,
      payload: {},
      scheduledAt: new Date(),
    });
    if (taskId) {
      return {
        response: jsonResponse({ accepted: true, taskId }, 202),
        audit: { metadata: { taskId } },
      };
    }
    // 已有活跃同步任务：不重复入队，返回既有任务 id 供前端跟踪其状态。
    const active = await taskRepo.findActiveTask({ kind: TASK_KIND_SYNC });
    return {
      response: jsonResponse(
        { accepted: false, taskId: active?.id ?? null, deduplicated: true },
        202,
      ),
      audit: { metadata: { taskId: active?.id ?? null, deduplicated: true } },
    };
  },
);

/** 写路由先做 CSRF 同源校验（跨源 403，不落审计），再进 withAudit。 */
export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
