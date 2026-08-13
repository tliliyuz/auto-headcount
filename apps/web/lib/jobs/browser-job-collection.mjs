import { BrowserCollectionContractError, LIEBIDE_JOB_DETAIL_CONTRACT_ID } from "../adapters/csdn-browser/browser-collection-contract.mjs";
import { BrowserRelayError } from "../adapters/csdn-browser/relay-client.mjs";

const TASK_KEYS = new Set(["sourceConnectionId", "userId", "deviceId", "contractId", "externalId"]);
const DAY_MS = 86_400_000;

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
  return {
    sourceConnectionId,
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    externalId: requireIdentifier(input.externalId, "externalId"),
  };
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
  const route = { userId: task.userId, deviceId: task.deviceId, expectedExternalId: task.externalId };
  try {
    const status = await relayClient.getConnectionStatus(route);
    if (!status.ready || status.status !== "READY") return failed(`BROWSER_${status.status}`, false, { preflight: 1 });
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

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new BrowserJobCollectionError(`${field} is required`);
  return value.trim();
}

function requireIdentifier(value, field) {
  const result = requireString(value, field);
  if (result.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(result)) throw new BrowserJobCollectionError(`${field} is invalid`);
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
