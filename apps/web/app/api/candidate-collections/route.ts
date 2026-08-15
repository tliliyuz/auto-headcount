import { randomUUID } from "node:crypto";

import { jsonResponse } from "../../../lib/identity/auth-http";
import { requireSameOrigin } from "../../../lib/identity/csrf.mjs";
import { createBrowserCandidateBatchRepository } from "../../../lib/jobs/browser-candidate-repository.mjs";
import { BrowserCandidateCollectionError, parseBrowserCandidateBatchDiscoverTaskPayload } from "../../../lib/jobs/browser-candidate-collection.mjs";
import { bindBrowserRoute, BrowserRouteConfigError } from "../../../lib/server/browser-route-config.mjs";
import { getDb } from "../../../lib/server/db";
import { withAudit } from "../../../lib/server/with-audit";

const handler = withAudit(
  {
    action: "candidate.collection.trigger",
    resourceType: "candidate_collection",
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
      payload = parseBrowserCandidateBatchDiscoverTaskPayload({
        ...bindBrowserRoute(body as Record<string, unknown>),
        batchId: randomUUID(),
      });
    } catch (error) {
      if (error instanceof BrowserRouteConfigError) {
        return { response: jsonResponse({ code: "browser_route_config_required", message: "浏览器采集路由尚未完成服务端配置" }, 503) };
      }
      if (error instanceof BrowserCandidateCollectionError) {
        return { response: jsonResponse({ code: "invalid_request", message: "浏览器候选人采集参数不合法" }, 400) };
      }
      throw error;
    }
    const { client } = getDb();
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
    const result = await createBrowserCandidateBatchRepository(client).createAndEnqueue({
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
  },
);

export const POST = (request: Request): Promise<Response> => {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return Promise.resolve(csrfBlock);
  return handler(request);
};
