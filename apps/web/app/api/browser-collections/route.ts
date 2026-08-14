import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { createAsyncTaskRepository } from "../../../lib/jobs/async-task-repository.mjs";
import { LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID } from "../../../lib/adapters/csdn-browser/browser-collection-contract.mjs";
import { createBrowserJobBatchRepository } from "../../../lib/jobs/browser-job-batch-repository.mjs";
import { BrowserJobCollectionError, parseBrowserJobBatchDiscoverTaskPayload, parseBrowserJobCollectTaskPayload } from "../../../lib/jobs/browser-job-collection.mjs";
import type { BrowserJobBatchDiscoverTaskPayload, BrowserJobCollectTaskPayload } from "../../../lib/jobs/browser-job-collection.mjs";
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
      // isBatch 由 contractId 判定（列表合同 → discover 载荷），与上方解析分支一一对应；
      // payload 类型是两载荷的联合，此处按判别显式收窄。
      const batchPayload = payload as BrowserJobBatchDiscoverTaskPayload;
      const requestPayload = {
        sourceConnectionId: batchPayload.sourceConnectionId,
        userId: batchPayload.userId,
        deviceId: batchPayload.deviceId,
        contractId: batchPayload.contractId,
        batchSize: batchPayload.batchSize,
        maxPages: batchPayload.maxPages,
        ...(batchPayload.startPage ? { startPage: batchPayload.startPage } : {}),
        ...(batchPayload.startOffset !== undefined ? { startOffset: batchPayload.startOffset } : {}),
      };
      const result = await createBrowserJobBatchRepository(client).createAndEnqueue({
        payload: requestPayload,
        scheduledAt: new Date(),
      });
      return {
        response: jsonResponse(result, 202),
        audit: {
          resourceId: result.batchId,
          metadata: { taskId: result.taskId, deduplicated: result.deduplicated || undefined, contractId: batchPayload.contractId },
        },
      };
    }
    const collectPayload = payload as BrowserJobCollectTaskPayload;
    const taskRepo = createAsyncTaskRepository(client);
    const taskId = await taskRepo.enqueueBrowserJobTaskIfTargetIdle({
      idempotencyKey: `browser-job-collect:manual:${randomUUID()}`,
      payload: collectPayload,
      scheduledAt: new Date(),
    });
    if (taskId) {
      return {
        response: jsonResponse({ accepted: true, taskId }, 202),
        audit: { resourceId: taskId, metadata: { taskId, contractId: collectPayload.contractId } },
      };
    }
    const active = await taskRepo.findActiveBrowserJobTask(collectPayload);
    return {
      response: jsonResponse({ accepted: false, taskId: active?.id ?? null, deduplicated: true }, 202),
      audit: {
        resourceId: active?.id ?? null,
        metadata: { taskId: active?.id ?? null, deduplicated: true, contractId: collectPayload.contractId },
      },
    };
  },
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
