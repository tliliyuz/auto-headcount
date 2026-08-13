export const CSDN_EXTRACTION_TOOL = "csdn_run_extraction_contract";
export const CSDN_CONNECTION_STATUS_TOOL = "csdn_get_browser_connection_status";
export const LIEBIDE_JOB_DETAIL_CONTRACT_ID = "liebide-job-detail-v1";
export const LIEBIDE_JOB_DETAIL_CONTRACT_VERSION = 1;
export const LIEBIDE_PLATFORM_ORIGIN = "https://portal.liebide.com";

const ROUTED_ARGUMENT_KEYS = new Set([
  "userId",
  "deviceId",
  "browserSessionId",
  "expectedExternalId",
]);
const CONNECTION_RESULT_KEYS = new Set([
  "status", "ready", "action", "registeredPageCount", "sessionMatched",
  "origin", "authState", "contractId", "entityMatched",
]);
const CONNECTION_STATUSES = new Set([
  "READY", "PAGE_NOT_REGISTERED", "BROWSER_SESSION_MISSING", "AUTH_REQUIRED",
  "WRONG_ORIGIN", "WRONG_ENTITY",
]);
const RESULT_KEYS = new Set([
  "contractId",
  "contractVersion",
  "status",
  "source",
  "record",
  "contentHash",
]);
const SOURCE_KEYS = new Set(["origin", "capturedAt"]);
const RECORD_KEYS = new Set([
  "externalId",
  "title",
  "status",
  "city",
  "salaryMin",
  "salaryMax",
  "jobDescription",
  "publishedAt",
  "validRecommendationCount",
]);
const SENSITIVE_KEY =
  /cookie|authorization|token|secret|password|passwd|captcha|session|phone|mobile|email|wechat|weixin|身份证/i;

export class BrowserCollectionContractError extends Error {
  constructor(message, code = "BROWSER_COLLECTION_CONTRACT_INVALID") {
    super(message);
    this.name = "BrowserCollectionContractError";
    this.code = code;
  }
}

/** 构造固定职位详情提取参数；拒绝任意脚本、选择器、URL 或未声明字段。 */
export function buildJobDetailExtractionArguments(input) {
  requirePlainObject(input, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  requireOnlyKeys(input, ROUTED_ARGUMENT_KEYS, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  const output = {
    userId: requireIdentifier(input.userId, "userId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    deviceId: requireIdentifier(
      input.deviceId,
      "deviceId",
      "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    ),
    contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    expectedExternalId: requireIdentifier(
      input.expectedExternalId,
      "expectedExternalId",
      "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    ),
  };
  if (input.browserSessionId !== undefined) {
    output.browserSessionId = requireIdentifier(
      input.browserSessionId, "browserSessionId", "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
  return output;
}

export function buildBrowserConnectionStatusArguments(input) {
  return buildJobDetailExtractionArguments(input);
}

export function parseBrowserConnectionStatusResult(input) {
  requirePlainObject(input, "connectionStatus");
  requireOnlyKeys(input, CONNECTION_RESULT_KEYS, "connectionStatus");
  if (!CONNECTION_STATUSES.has(input.status)) throw invalid("connection status is unsupported");
  if (typeof input.ready !== "boolean") throw invalid("connection ready must be boolean");
  if ((input.status === "READY") !== input.ready) throw invalid("connection ready conflicts with status");
  if (input.contractId !== LIEBIDE_JOB_DETAIL_CONTRACT_ID) throw invalid("connection contract is unsupported");
  if (!Number.isInteger(input.registeredPageCount) || input.registeredPageCount < 0) throw invalid("connection page count is invalid");
  for (const key of ["sessionMatched", "entityMatched"]) {
    if (typeof input[key] !== "boolean") throw invalid(`connection ${key} must be boolean`);
  }
  if (input.origin !== null && typeof input.origin !== "string") throw invalid("connection origin is invalid");
  for (const key of ["action", "authState"]) requireString(input[key], `connection.${key}`);
  return { ...input };
}

/** 严格解析 CSDN-Agent 的职位详情白名单回执，未知/敏感/截断字段一律失败关闭。 */
export function parseJobDetailExtractionResult(input) {
  requirePlainObject(input, "result");
  rejectSensitiveKeys(input, "result");
  requireOnlyKeys(input, RESULT_KEYS, "result");
  if (input.contractId !== LIEBIDE_JOB_DETAIL_CONTRACT_ID) {
    throw invalid("result.contractId is not supported");
  }
  if (input.contractVersion !== LIEBIDE_JOB_DETAIL_CONTRACT_VERSION) {
    throw invalid("result.contractVersion is not supported");
  }
  if (input.status !== "extracted") {
    throw invalid("result.status must be extracted");
  }

  requirePlainObject(input.source, "result.source");
  requireOnlyKeys(input.source, SOURCE_KEYS, "result.source");
  if (input.source.origin !== LIEBIDE_PLATFORM_ORIGIN) {
    throw invalid("result.source.origin is not allowed");
  }
  const capturedAt = requireIsoDate(input.source.capturedAt, "result.source.capturedAt");

  requirePlainObject(input.record, "result.record");
  requireOnlyKeys(input.record, RECORD_KEYS, "result.record");
  const record = input.record;
  const salaryMin = requireNullableNonNegativeInteger(
    record.salaryMin,
    "result.record.salaryMin",
  );
  const salaryMax = requireNullableNonNegativeInteger(
    record.salaryMax,
    "result.record.salaryMax",
  );
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
    throw invalid("result.record salary range is invalid");
  }

  const contentHash = requireString(input.contentHash, "result.contentHash");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw invalid("result.contentHash must be lowercase sha256 hex");
  }

  return {
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    sourceOrigin: input.source.origin,
    capturedAt,
    contentHash,
    externalId: requireIdentifier(record.externalId, "result.record.externalId"),
    title: requireString(record.title, "result.record.title"),
    status: requireString(record.status, "result.record.status"),
    city: requireString(record.city, "result.record.city", true),
    salaryMin,
    salaryMax,
    jobDescription: requireString(
      record.jobDescription,
      "result.record.jobDescription",
    ),
    publishedAt:
      record.publishedAt === null
        ? null
        : requireIsoDate(record.publishedAt, "result.record.publishedAt"),
    validRecommendationCount: requireNullableNonNegativeInteger(
      record.validRecommendationCount,
      "result.record.validRecommendationCount",
    ),
  };
}

function rejectSensitiveKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw invalid(`${path}.${key} is forbidden`);
    rejectSensitiveKeys(child, `${path}.${key}`);
  }
}

function requireOnlyKeys(value, allowed, path, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new BrowserCollectionContractError(`${path}.${key} is not allowed`, code);
    }
  }
}

function requirePlainObject(value, path, code) {
  if (!isPlainObject(value)) {
    throw new BrowserCollectionContractError(`${path} must be an object`, code);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireIdentifier(value, path, code) {
  if (typeof value !== "string") {
    throw new BrowserCollectionContractError(`${path} must be a string`, code);
  }
  const normalized = value.trim();
  if (normalized === "") {
    throw new BrowserCollectionContractError(`${path} must not be empty`, code);
  }
  if (normalized.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(normalized)) {
    throw new BrowserCollectionContractError(`${path} is invalid`, code);
  }
  return normalized;
}

function requireString(value, path, allowEmpty = false) {
  if (typeof value !== "string") throw invalid(`${path} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized === "") throw invalid(`${path} must not be empty`);
  if (value.length > 200000) throw invalid(`${path} is too large`);
  return normalized;
}

function requireIsoDate(value, path) {
  const normalized = requireString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw invalid(`${path} must be an ISO timestamp`);
  }
  return normalized;
}

function requireNullableNonNegativeInteger(value, path) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`${path} must be a non-negative integer or null`);
  }
  return value;
}

function invalid(message) {
  return new BrowserCollectionContractError(message);
}
