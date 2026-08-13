import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { createAsyncTaskRepository } from "../../../lib/jobs/async-task-repository.mjs";
import { getDb } from "../../../lib/server/db";
import { withAudit } from "../../../lib/server/with-audit";

const ALLOWED_ROLES = ["operations", "admin"];
const TASK_KIND_MATCH = "match_candidates_sync";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 手动触发匹配任务（写路由，M2）：对选定的可操作职位入队一个 `match_candidates_sync` 任务，
 * 由调度 tick 认领执行 `wb.jobs.match_candidates`——不做长请求内匹配。
 * 返回 202 accepted + taskId；会话 + RBAC operations/admin + 写审计（withAudit）。
 *
 * - 校验 job_ids 非空、均为合法 UUID、对应职位存在且 `operability_status='actionable'`。
 * - `enqueueTaskIfIdle` 按 kind 单飞（同时只跑一个匹配任务），活跃被拦截返回
 *   `accepted:false + deduplicated:true`（评分有 LLM 成本，避免并发打分）。
 */
const handler = withAudit(
  {
    action: "match-tasks.trigger",
    resourceType: "match",
    allowedRoles: ALLOWED_ROLES,
    auditMetadataKeys: ["taskId", "deduplicated", "jobCount"],
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
    const raw = (body as { job_ids?: unknown })?.job_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "job_ids 不能为空" },
          400,
        ),
      };
    }
    const jobIds = raw.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
    if (jobIds.length === 0) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "job_ids 含非法 UUID" },
          400,
        ),
      };
    }

    const { client } = getDb();
    // 只允许对可操作职位建匹配任务（docs/04 §6：可操作 = wb.jobs.list 账号自身作用域）。
    const [jobCount] = await client`
      select count(*)::int as n
      from jobs
      where id = any(${jobIds}) and operability_status = 'actionable'
    `;
    if (jobCount.n !== jobIds.length) {
      return {
        response: jsonResponse(
          { code: "invalid_request", message: "存在不可操作或不存在的职位" },
          400,
        ),
      };
    }

    const taskRepo = createAsyncTaskRepository(client);
    const taskId = await taskRepo.enqueueTaskIfIdle({
      kind: TASK_KIND_MATCH,
      idempotencyKey: `match-candidates:manual:${randomUUID()}`,
      payload: { jobIds },
      scheduledAt: new Date(),
    });
    if (taskId) {
      return {
        response: jsonResponse({ accepted: true, taskId }, 202),
        audit: { metadata: { taskId, jobCount: jobIds.length } },
      };
    }
    // 已有活跃匹配任务：不重复入队，返回既有任务 id（评分有成本，避免并发打分）。
    const active = await taskRepo.findActiveTask({ kind: TASK_KIND_MATCH });
    return {
      response: jsonResponse(
        { accepted: false, taskId: active?.id ?? null, deduplicated: true },
        202,
      ),
      audit: {
        metadata: {
          taskId: active?.id ?? null,
          deduplicated: true,
          jobCount: jobIds.length,
        },
      },
    };
  },
);

/** 写路由先做 CSRF 同源校验（跨源 403，不落审计），再进 withAudit。 */
export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
