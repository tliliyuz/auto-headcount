import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { createAsyncTaskRepository } from "../../../lib/jobs/async-task-repository.mjs";
import { BrowserJobCollectionError, parseBrowserJobCollectTaskPayload } from "../../../lib/jobs/browser-job-collection.mjs";
import { getDb } from "../../../lib/server/db";
import { withAudit } from "../../../lib/server/with-audit";

const handler = withAudit(
  {
    action: "browser.collection.trigger",
    resourceType: "browser_collection",
    allowedRoles: ["operations", "admin"],
    auditMetadataKeys: ["taskId", "deduplicated", "contractId"],
  },
  async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.request.json();
    } catch {
      return { response: jsonResponse({ code: "invalid_request", message: "请求体必须是 JSON" }, 400) };
    }
    let payload;
    try {
      payload = parseBrowserJobCollectTaskPayload(body);
    } catch (error) {
      if (error instanceof BrowserJobCollectionError) {
        return { response: jsonResponse({ code: "invalid_request", message: "浏览器职位采集参数不合法" }, 400) };
      }
      throw error;
    }
    const { client } = getDb();
    const taskRepo = createAsyncTaskRepository(client);
    const taskId = await taskRepo.enqueueBrowserJobTaskIfTargetIdle({
      idempotencyKey: `browser-job-collect:manual:${randomUUID()}`,
      payload,
      scheduledAt: new Date(),
    });
    if (taskId) {
      return {
        response: jsonResponse({ accepted: true, taskId }, 202),
        audit: { resourceId: taskId, metadata: { taskId, contractId: payload.contractId } },
      };
    }
    const active = await taskRepo.findActiveBrowserJobTask(payload);
    return {
      response: jsonResponse({ accepted: false, taskId: active?.id ?? null, deduplicated: true }, 202),
      audit: {
        resourceId: active?.id ?? null,
        metadata: { taskId: active?.id ?? null, deduplicated: true, contractId: payload.contractId },
      },
    };
  },
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
