import { BrowserCollectionContractError, LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID, LIEBIDE_JOB_DETAIL_CONTRACT_ID, LIEBIDE_PLATFORM_ORIGIN } from "../adapters/csdn-browser/browser-collection-contract.mjs";
import { BrowserRelayError } from "../adapters/csdn-browser/relay-client.mjs";

const TASK_KEYS = new Set(["collectionBatchId", "collectionItemId", "sourceConnectionId", "userId", "deviceId", "contractId", "externalId", "expectedTitle"]);
const BATCH_TASK_KEYS = new Set(["batchId", "sourceConnectionId", "userId", "deviceId", "contractId", "batchSize", "maxPages", "startPage", "startOffset"]);
const DAY_MS = 86_400_000;
/** 差分发现安全阀：单批次最多调用的发现次数与累计翻页数，防止已知职位占满列表时无限翻页。 */
const MAX_DISCOVERY_LOOP_CALLS = 10;
const MAX_DISCOVERY_TOTAL_PAGES = 60;

export class BrowserJobCollectionError extends Error {
  constructor(message, code = "BROWSER_JOB_TASK_INVALID") {
    super(message);
    this.name = "BrowserJobCollectionError";
    this.code = code;
  }
}

export function parseBrowserJobCollectTaskPayload(input) {
  if (!isPlainObject(input)) throw new BrowserJobCollectionError("task payload must be an object");
  for (const key of Object.keys(input)) {
    if (!TASK_KEYS.has(key)) throw new BrowserJobCollectionError(`task payload field ${key} is forbidden`);
  }
  const sourceConnectionId = requireString(input.sourceConnectionId, "sourceConnectionId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceConnectionId)) {
    throw new BrowserJobCollectionError("sourceConnectionId must be a UUID");
  }
  if (input.contractId !== LIEBIDE_JOB_DETAIL_CONTRACT_ID) throw new BrowserJobCollectionError("contractId is unsupported");
  const output = {
    sourceConnectionId,
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    externalId: requireIdentifier(input.externalId, "externalId"),
  };
  if (input.collectionBatchId !== undefined) output.collectionBatchId = requireUuid(input.collectionBatchId, "collectionBatchId");
  if (input.collectionItemId !== undefined) output.collectionItemId = requireUuid(input.collectionItemId, "collectionItemId");
  if ((output.collectionBatchId === undefined) !== (output.collectionItemId === undefined)) throw new BrowserJobCollectionError("collection batch and item must be provided together");
  if (input.expectedTitle !== undefined) output.expectedTitle = requireTitle(input.expectedTitle, "expectedTitle");
  return output;
}

export function parseBrowserJobBatchDiscoverTaskPayload(input) {
  if (!isPlainObject(input)) throw new BrowserJobCollectionError("task payload must be an object");
  for (const key of Object.keys(input)) if (!BATCH_TASK_KEYS.has(key)) throw new BrowserJobCollectionError(`task payload field ${key} is forbidden`);
  const batchId = requireUuid(input.batchId, "batchId");
  const sourceConnectionId = requireUuid(input.sourceConnectionId, "sourceConnectionId");
  if (input.contractId !== LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID) throw new BrowserJobCollectionError("contractId is unsupported");
  const output = {
    batchId, sourceConnectionId,
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    batchSize: requireInteger(input.batchSize, "batchSize", 1, 100),
    maxPages: requireInteger(input.maxPages, "maxPages", 1, 20),
  };
  if (input.startPage !== undefined) output.startPage = requireInteger(input.startPage, "startPage", 1, 10000);
  if (input.startOffset !== undefined) output.startOffset = requireInteger(input.startOffset, "startOffset", 0, 10000);
  return output;
}

/**
 * 差分发现：`batchSize` = 本批要采集的「新增 + 标题变化」职位数。
 * 逐页调用发现合同，跳过已入库且标题未变的职位（计入 skippedKnown），
 * 直到凑满目标或列表到底；标题变化的已知职位按变更重新采集（upsert 覆盖）。
 */
export async function runBrowserJobBatchDiscovery({ task: rawTask, relayClient, repository }) {
  let task;
  try { task = parseBrowserJobBatchDiscoverTaskPayload(rawTask); }
  catch (error) { return failed(error.code ?? "BROWSER_JOB_TASK_INVALID", false); }
  if (!(await repository.sourceExists(task.sourceConnectionId))) return failed("BROWSER_SOURCE_NOT_FOUND", false);
  const known = new Map(
    ((await repository.findKnownExternalIds({ sourceConnectionId: task.sourceConnectionId })) ?? []).map(
      (row) => [row.externalId, row.title],
    ),
  );
  const targetCount = task.batchSize;
  try {
    // 列表合同连接状态参数构建器（buildFilteredJobListConnectionStatusArguments）内部要求
    // batchSize/maxPages 存在（白名单校验），预检必须带齐，否则 BROWSER_COLLECTION_ARGUMENTS_INVALID。
    const preflightStatus = await relayClient.getConnectionStatus({
      userId: task.userId, deviceId: task.deviceId, contractId: task.contractId,
      batchSize: task.batchSize, maxPages: task.maxPages,
    });
    if (!preflightStatus.ready || preflightStatus.status !== "READY") {
      return failed(`BROWSER_${preflightStatus.status}`, false, { preflight: 1 });
    }

    const collected = [];
    let skippedKnown = 0;
    let rawSeen = 0;
    let calls = 0;
    let totalPagesVisited = 0;
    let lastStopReason = null;
    let lastNextPage = null;
    let lastNextOffset = null;
    let cursor = {
      ...(task.startPage ? { startPage: task.startPage } : {}),
      ...(task.startOffset !== undefined ? { startOffset: task.startOffset } : {}),
    };

    while (collected.length < targetCount && calls < MAX_DISCOVERY_LOOP_CALLS) {
      const route = {
        userId: task.userId, deviceId: task.deviceId, contractId: task.contractId,
        batchSize: task.batchSize, maxPages: task.maxPages, ...cursor,
      };
      const discovery = await relayClient.discoverFilteredJobs(route);
      calls += 1;
      totalPagesVisited += discovery.pagesVisited;
      rawSeen += discovery.items.length;
      for (const item of discovery.items) {
        const knownTitle = known.get(item.externalId);
        if (knownTitle !== undefined && normalizeTitle(knownTitle) === normalizeTitle(item.title)) {
          skippedKnown += 1;
          continue;
        }
        collected.push(item);
      }
      lastStopReason = discovery.stopReason;
      lastNextPage = discovery.nextPage;
      lastNextOffset = discovery.nextOffset ?? null;
      if (collected.length >= targetCount) {
        lastStopReason = discovery.nextPage === null ? lastStopReason : "target_reached";
        break;
      }
      if (discovery.nextPage === null) break;
      cursor = { startPage: discovery.nextPage, startOffset: discovery.nextOffset ?? 0 };
      if (totalPagesVisited >= MAX_DISCOVERY_TOTAL_PAGES) break;
    }

    const saved = await repository.persistDiscovery({
      batch: task,
      discovery: {
        items: collected,
        nextPage: lastNextPage,
        nextOffset: lastNextOffset,
        stopReason: lastStopReason,
      },
      detailContractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    });
    return {
      status: "succeeded", retryable: false, ...saved,
      stats: {
        preflight: 1, pages: totalPagesVisited,
        discovered: rawSeen, newOrChanged: collected.length, skippedKnown,
        enqueued: saved.enqueuedDetails ?? collected.length,
        stopReason: lastStopReason,
      },
    };
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError) return failed(error.code, false);
    return failed("BROWSER_JOB_DISCOVER_INTERNAL_ERROR", false);
  }
}

export function evaluateBrowserJobEligibility(record, now) {
  const publishedAt = record.publishedAt ? new Date(record.publishedAt) : null;
  const validDate = publishedAt && !Number.isNaN(publishedAt.getTime());
  const ageDays = validDate ? Math.floor((now.getTime() - publishedAt.getTime()) / DAY_MS) : null;
  let reason = null;
  if (record.status !== "active") reason = "STATUS_NOT_ACTIVE";
  else if (ageDays === null || ageDays < 0) reason = "PUBLISHED_AT_REQUIRED";
  else if (ageDays < 7 || ageDays > 30) reason = "AGE_OUT_OF_RANGE";
  else if (record.validRecommendationCount === null) reason = "RECOMMENDATION_COUNT_REQUIRED";
  else if (record.validRecommendationCount !== 0) reason = "HAS_VALID_RECOMMENDATIONS";
  return { eligible: reason === null, ageDays, reason };
}

export async function runBrowserJobCollection({ task: rawTask, now = new Date(), relayClient, repository }) {
  let task;
  try {
    task = parseBrowserJobCollectTaskPayload(rawTask);
  } catch (error) {
    return failed(error.code ?? "BROWSER_JOB_TASK_INVALID", false);
  }
  if (!(await repository.sourceExists(task.sourceConnectionId))) return failed("BROWSER_SOURCE_NOT_FOUND", false);
  const route = {
    userId: task.userId,
    deviceId: task.deviceId,
    expectedExternalId: task.externalId,
    ...(task.expectedTitle ? { expectedTitle: task.expectedTitle } : {}),
  };
  try {
    const status = await relayClient.getConnectionStatus({
      ...route,
      contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    });
    const ready = status.ready && status.status === "READY";
    const mayNavigateDeterministically =
      status.status === "WRONG_ENTITY" &&
      status.sessionMatched === true &&
      status.origin === LIEBIDE_PLATFORM_ORIGIN &&
      status.authState === "authenticated";
    if (!ready && !mayNavigateDeterministically) {
      return failed(`BROWSER_${status.status}`, false, { preflight: 1 });
    }
    const record = await relayClient.extractJobDetail(route);
    if (record.externalId !== task.externalId) return failed("BROWSER_ENTITY_MISMATCH", false, { preflight: 1, extracted: 1 });
    const eligibility = evaluateBrowserJobEligibility(record, now);
    if (!eligibility.eligible) {
      return {
        status: "succeeded", retryable: false,
        stats: { preflight: 1, extracted: 1, eligible: 0, persisted: 0, skipped: 1 },
        skipReason: eligibility.reason,
      };
    }
    const saved = await repository.persist({
      sourceConnectionId: task.sourceConnectionId,
      contractId: task.contractId,
      record,
      job: {
        externalId: record.externalId,
        title: record.title,
        companyName: "",
        category: "",
        city: record.city,
        salaryMin: record.salaryMin,
        salaryMax: record.salaryMax,
        jobDescription: record.jobDescription,
        status: "active",
        publishedAt: record.publishedAt,
        ageDays: eligibility.ageDays,
        validRecommendationCount: 0,
        operabilityStatus: "actionable",
        portalUrl: `https://portal.liebide.com/#/Job/${encodeURIComponent(record.externalId)}`,
        sourceUpdatedAt: record.capturedAt,
        eligibilityEvidence: {
          activeStatus: "liebide-job-detail-v1",
          age: "published_at_local_calculation",
          zeroRecommendations: "valid_recommendation_count",
          companyName: "source_missing",
          category: "source_missing",
        },
      },
    });
    return {
      status: "succeeded", retryable: false, ...saved,
      stats: { preflight: 1, extracted: 1, eligible: 1, persisted: 1, skipped: 0 },
    };
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError) return failed(error.code, false);
    return failed("BROWSER_JOB_COLLECT_INTERNAL_ERROR", false);
  }
}

function failed(errorCode, retryable, stats = null) {
  return { status: "failed", errorCode, retryable, stats };
}

/** 标题变化检测：与详情合同 `expectedTitle` 校验一致的空白归一（折叠空白），避免纯空白差异触发重采。 */
function normalizeTitle(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new BrowserJobCollectionError(`${field} is required`);
  return value.trim();
}

function requireIdentifier(value, field) {
  const result = requireString(value, field);
  if (result.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(result)) throw new BrowserJobCollectionError(`${field} is invalid`);
  return result;
}

function requireTitle(value, field) {
  const result = requireString(value, field);
  if (result.length > 500) throw new BrowserJobCollectionError(`${field} is too long`);
  return result;
}

function requireUuid(value, field) {
  const result = requireString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new BrowserJobCollectionError(`${field} must be a UUID`);
  return result;
}

function requireInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new BrowserJobCollectionError(`${field} must be between ${min} and ${max}`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
