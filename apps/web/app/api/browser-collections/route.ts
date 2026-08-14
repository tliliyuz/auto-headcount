import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { createAsyncTaskRepository } from "../../../lib/jobs/async-task-repository.mjs";
import { LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID } from "../../../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import { createBrowserJobBatchRepository } from "../../../lib/jobs/browser-job-batch-repository.mjs";
import { BrowserJobCollectionError, parseBrowserJobBatchDiscoverTaskPayload, parseBrowserJobCollectTaskPayload } from "../../../lib/jobs/browser-job-collection.mjs";
import { bindBrowserRoute, BrowserRouteConfigError } from "../../../lib/server/browser-route-config.mjs";
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
    const isBatch = typeof body === "object" && body !== null && (body as { contractId?: unknown }).contractId === LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID;
    let payload;
    try {
      payload = isBatch
        ? parseBrowserJobBatchDiscoverTaskPayload({
            ...bindBrowserRoute(body as Record<string, unknown>),
            batchId: randomUUID(),
          })
        : parseBrowserJobCollectTaskPayload(body);
    } catch (error) {
      if (error instanceof BrowserRouteConfigError) {
        return { response: jsonResponse({ code: "browser_route_config_required", message: "浏览器采集路由尚未完成服务端配置" }, 503) };
      }
      if (error instanceof BrowserJobCollectionError) {
        return { response: jsonResponse({ code: "invalid_request", message: "浏览器职位采集参数不合法" }, 400) };
      }
      throw error;
    }
    const { client } = getDb();
    if (isBatch) {
      const requestPayload = {
        sourceConnectionId: payload.sourceConnectionId,
        userId: payload.userId,
        deviceId: payload.deviceId,
        contractId: payload.contractId,
        batchSize: payload.batchSize,
        maxPages: payload.maxPages,
        ...(payload.startPage ? { startPage: payload.startPage } : {}),
        ...(payload.startOffset !== undefined ? { startOffset: payload.startOffset } : {}),
      };
      const result = await createBrowserJobBatchRepository(client).createAndEnqueue({
        payload: requestPayload,
        scheduledAt: new Date(),
      });
      return {
        response: jsonResponse(result, 202),
        audit: {
          resourceId: result.batchId,
          metadata: { taskId: result.taskId, deduplicated: result.deduplicated || undefined, contractId: payload.contractId },
        },
      };
    }
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
