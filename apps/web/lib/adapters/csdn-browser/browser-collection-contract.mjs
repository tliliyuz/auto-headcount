export const CSDN_EXTRACTION_TOOL = "csdn_run_extraction_contract";
export const CSDN_CONNECTION_STATUS_TOOL = "csdn_get_browser_connection_status";
export const LIEBIDE_JOB_DETAIL_CONTRACT_ID = "liebide-job-detail-v1";
export const LIEBIDE_JOB_DETAIL_CONTRACT_VERSION = 1;
export const LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID = "liebide-filtered-job-list-v2";
export const LIEBIDE_FILTERED_JOB_LIST_CONTRACT_VERSION = 2;
export const LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID = "liebide-talent-pool-list-v1";
export const LIEBIDE_TALENT_POOL_LIST_CONTRACT_VERSION = 1;
export const LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID = "liebide-candidate-detail-v1";
export const LIEBIDE_CANDIDATE_DETAIL_CONTRACT_VERSION = 1;
export const LIEBIDE_PLATFORM_ORIGIN = "https://portal.liebide.com";

const ROUTED_ARGUMENT_KEYS = new Set([
  "userId",
  "deviceId",
  "browserSessionId",
  "expectedExternalId",
  "expectedTitle",
]);
const LIST_ARGUMENT_KEYS = new Set([
  "userId", "deviceId", "browserSessionId", "batchSize", "maxPages", "startPage", "startOffset",
]);
const CANDIDATE_DETAIL_ARGUMENT_KEYS = new Set([
  "userId", "deviceId", "browserSessionId", "expectedCandidateId", "expectedTitle",
]);
const TALENT_POOL_LIST_ARGUMENT_KEYS = new Set([
  "userId", "deviceId", "browserSessionId", "batchSize", "maxPages", "startPage", "startOffset",
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
const LIST_RESULT_KEYS = new Set([
  "contractId", "contractVersion", "status", "source", "filterEvidence", "items", "page", "contentHash",
]);
const LIST_FILTER_KEYS = new Set(["recommendationCount", "publishedAgeDaysMin", "publishedAgeDaysMax"]);
const LIST_ITEM_KEYS = new Set(["externalId", "title", "pageNumber", "position"]);
const LIST_PAGE_KEYS = new Set(["startPage", "startOffset", "endPage", "pagesVisited", "nextPage", "nextOffset", "stopReason"]);
const LIST_STOP_REASONS = new Set(["batch_size", "max_pages", "end_of_results"]);
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
  if (input.expectedTitle !== undefined) {
    output.expectedTitle = requireTitle(
      input.expectedTitle, "expectedTitle", "BROWSER_COLLECTION_ARGUMENTS_INVALID",
    );
  }
  return output;
}

export function buildBrowserConnectionStatusArguments(input) {
  return buildJobDetailExtractionArguments(input);
}

/** 构造筛选列表固定合同参数；页码是唯一允许持久化的浏览器断点。 */
export function buildFilteredJobListExtractionArguments(input) {
  requirePlainObject(input, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  requireOnlyKeys(input, LIST_ARGUMENT_KEYS, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  const output = {
    userId: requireIdentifier(input.userId, "userId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    deviceId: requireIdentifier(input.deviceId, "deviceId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    contractId: LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID,
    batchSize: requireBoundedInteger(input.batchSize, "batchSize", 1, 100, "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    maxPages: requireBoundedInteger(input.maxPages, "maxPages", 1, 20, "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
  };
  if (input.browserSessionId !== undefined) output.browserSessionId = requireIdentifier(input.browserSessionId, "browserSessionId", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  if (input.startPage !== undefined) output.startPage = requireBoundedInteger(input.startPage, "startPage", 1, 10000, "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  if (input.startOffset !== undefined) output.startOffset = requireBoundedInteger(input.startOffset, "startOffset", 0, 10000, "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  return output;
}

export function buildFilteredJobListConnectionStatusArguments(input) {
  const args = buildFilteredJobListExtractionArguments(input);
  return { userId: args.userId, deviceId: args.deviceId, ...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}), contractId: args.contractId };
}

/** 构造人才池列表固定合同参数（候选人发现）；页码是唯一允许持久化的浏览器断点。 */
export function buildTalentPoolListExtractionArguments(input) {
  requirePlainObject(input, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  requireOnlyKeys(input, TALENT_POOL_LIST_ARGUMENT_KEYS, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  const output = {
    userId: requireIdentifier(input.userId, "userId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    deviceId: requireIdentifier(input.deviceId, "deviceId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    contractId: LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
    batchSize: requireBoundedInteger(input.batchSize, "batchSize", 1, 100, "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    maxPages: requireBoundedInteger(input.maxPages, "maxPages", 1, 20, "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
  };
  if (input.browserSessionId !== undefined) output.browserSessionId = requireIdentifier(input.browserSessionId, "browserSessionId", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  if (input.startPage !== undefined) output.startPage = requireBoundedInteger(input.startPage, "startPage", 1, 10000, "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  if (input.startOffset !== undefined) output.startOffset = requireBoundedInteger(input.startOffset, "startOffset", 0, 10000, "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  return output;
}

export function buildTalentPoolListConnectionStatusArguments(input) {
  const args = buildTalentPoolListExtractionArguments(input);
  return { userId: args.userId, deviceId: args.deviceId, ...(args.browserSessionId ? { browserSessionId: args.browserSessionId } : {}), contractId: args.contractId };
}

/** 构造候选人画像详情固定合同参数；拒绝任意脚本、选择器、URL 或未声明字段。 */
export function buildCandidateDetailExtractionArguments(input) {
  requirePlainObject(input, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  requireOnlyKeys(input, CANDIDATE_DETAIL_ARGUMENT_KEYS, "input", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  const output = {
    userId: requireIdentifier(input.userId, "userId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    deviceId: requireIdentifier(input.deviceId, "deviceId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
    contractId: LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
    expectedCandidateId: requireIdentifier(input.expectedCandidateId, "expectedCandidateId", "BROWSER_COLLECTION_ARGUMENTS_INVALID"),
  };
  if (input.browserSessionId !== undefined) {
    output.browserSessionId = requireIdentifier(input.browserSessionId, "browserSessionId", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  }
  if (input.expectedTitle !== undefined) {
    output.expectedTitle = requireTitle(input.expectedTitle, "expectedTitle", "BROWSER_COLLECTION_ARGUMENTS_INVALID");
  }
  return output;
}

/** 候选人画像详情连接预检参数（与详情提取同参；含身份路由 expectedCandidateId，无持久化 session）。 */
export function buildCandidateDetailConnectionStatusArguments(input) {
  return buildCandidateDetailExtractionArguments(input);
}

export function parseBrowserConnectionStatusResult(input) {
  requirePlainObject(input, "connectionStatus");
  requireOnlyKeys(input, CONNECTION_RESULT_KEYS, "connectionStatus");
  if (!CONNECTION_STATUSES.has(input.status)) throw invalid("connection status is unsupported");
  if (typeof input.ready !== "boolean") throw invalid("connection ready must be boolean");
  if ((input.status === "READY") !== input.ready) throw invalid("connection ready conflicts with status");
  if (![LIEBIDE_JOB_DETAIL_CONTRACT_ID, LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID, LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID, LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID].includes(input.contractId)) throw invalid("connection contract is unsupported");
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

/** 严格解析筛选列表回执；Consumer 再次执行调用上限与唯一 ID 检查。 */
export function parseFilteredJobListExtractionResult(input, limits) {
  requirePlainObject(input, "result");
  rejectSensitiveKeys(input, "result");
  requireOnlyKeys(input, LIST_RESULT_KEYS, "result");
  if (input.contractId !== LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID || input.contractVersion !== LIEBIDE_FILTERED_JOB_LIST_CONTRACT_VERSION || input.status !== "extracted") throw invalid("filtered list contract is unsupported");
  requirePlainObject(input.source, "result.source");
  requireOnlyKeys(input.source, SOURCE_KEYS, "result.source");
  if (input.source.origin !== LIEBIDE_PLATFORM_ORIGIN) throw invalid("result.source.origin is not allowed");
  const source = { origin: input.source.origin, capturedAt: requireIsoDate(input.source.capturedAt, "result.source.capturedAt") };
  requirePlainObject(input.filterEvidence, "result.filterEvidence");
  requireOnlyKeys(input.filterEvidence, LIST_FILTER_KEYS, "result.filterEvidence");
  if (input.filterEvidence.recommendationCount !== 0 || input.filterEvidence.publishedAgeDaysMin !== 0 || input.filterEvidence.publishedAgeDaysMax !== 30) throw invalid("result filter evidence is not the approved discovery filter");
  if (!Array.isArray(input.items)) throw invalid("result.items must be an array");
  const batchSize = requireBoundedInteger(limits?.batchSize, "limits.batchSize", 1, 100);
  const maxPages = requireBoundedInteger(limits?.maxPages, "limits.maxPages", 1, 20);
  if (input.items.length > batchSize) throw invalid("result.items exceeds batchSize");
  const seen = new Set();
  const items = input.items.map((item, index) => {
    requirePlainObject(item, `result.items[${index}]`);
    requireOnlyKeys(item, LIST_ITEM_KEYS, `result.items[${index}]`);
    const externalId = requireIdentifier(item.externalId, `result.items[${index}].externalId`);
    if (seen.has(externalId)) throw invalid("result.items contains duplicate externalId");
    seen.add(externalId);
    return {
      externalId,
      title: requireString(item.title, `result.items[${index}].title`),
      pageNumber: requireBoundedInteger(item.pageNumber, `result.items[${index}].pageNumber`, 1, 10000),
      position: requireBoundedInteger(item.position, `result.items[${index}].position`, 1, 10000),
    };
  });
  requirePlainObject(input.page, "result.page");
  requireOnlyKeys(input.page, LIST_PAGE_KEYS, "result.page");
  const page = {
    startPage: requireBoundedInteger(input.page.startPage, "result.page.startPage", 1, 10000),
    startOffset: requireBoundedInteger(input.page.startOffset, "result.page.startOffset", 0, 10000),
    endPage: requireBoundedInteger(input.page.endPage, "result.page.endPage", 1, 10000),
    pagesVisited: requireBoundedInteger(input.page.pagesVisited, "result.page.pagesVisited", 1, maxPages),
    nextPage: input.page.nextPage === null ? null : requireBoundedInteger(input.page.nextPage, "result.page.nextPage", 1, 10000),
    nextOffset: input.page.nextOffset === null ? null : requireBoundedInteger(input.page.nextOffset, "result.page.nextOffset", 0, 10000),
    stopReason: input.page.stopReason,
  };
  if (!LIST_STOP_REASONS.has(page.stopReason) || page.endPage < page.startPage) throw invalid("result.page is invalid");
  const contentHash = requireString(input.contentHash, "result.contentHash");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw invalid("result.contentHash must be lowercase sha256 hex");
  return {
    contractId: input.contractId, contractVersion: input.contractVersion, status: input.status,
    source, filterEvidence: { ...input.filterEvidence }, items, page, contentHash,
    nextPage: page.nextPage, nextOffset: page.nextOffset, stopReason: page.stopReason, pagesVisited: page.pagesVisited,
  };
}

const TALENT_POOL_RESULT_KEYS = new Set([
  "contractId", "contractVersion", "status", "source", "filterEvidence", "items", "page", "contentHash",
]);
const TALENT_POOL_FILTER_KEYS = new Set(["category"]);
const TALENT_POOL_ITEM_KEYS = new Set([
  "candidateId", "realName", "title", "company", "yearOfExperience", "age", "gender",
  "city", "education", "pageNumber", "position",
]);
const TALENT_POOL_PAGE_KEYS = new Set(["startPage", "startOffset", "endPage", "pagesVisited", "nextPage", "nextOffset", "stopReason"]);
const CANDIDATE_DETAIL_RESULT_KEYS = new Set([
  "contractId", "contractVersion", "status", "source", "record", "contentHash",
]);
const CANDIDATE_RECORD_KEYS = new Set([
  "candidateId", "realName", "title", "company", "yearOfExperience", "cityName",
  "school", "major", "degree", "completion", "recommendationCount", "workExperiences",
]);
const WORK_EXPERIENCE_KEYS = new Set(["company", "title"]);
/** 简历正文 / 自我评价等不在候选人画像白名单内，即使被 Provider 误传也失败关闭。 */
const CANDIDATE_FORBIDDEN_KEYS = /content|selfEvaluation|projectExperiences|mobile|email|wechat|phone/i;

/** 严格解析人才池列表回执；固定分类证据、唯一候选人 ID 与有界断点。 */
export function parseTalentPoolListExtractionResult(input, limits) {
  requirePlainObject(input, "result");
  rejectSensitiveKeys(input, "result");
  requireOnlyKeys(input, TALENT_POOL_RESULT_KEYS, "result");
  if (input.contractId !== LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID || input.contractVersion !== LIEBIDE_TALENT_POOL_LIST_CONTRACT_VERSION || input.status !== "extracted") throw invalid("talent pool list contract is unsupported");
  requirePlainObject(input.source, "result.source");
  requireOnlyKeys(input.source, SOURCE_KEYS, "result.source");
  if (input.source.origin !== LIEBIDE_PLATFORM_ORIGIN) throw invalid("result.source.origin is not allowed");
  const source = { origin: input.source.origin, capturedAt: requireIsoDate(input.source.capturedAt, "result.source.capturedAt") };
  requirePlainObject(input.filterEvidence, "result.filterEvidence");
  requireOnlyKeys(input.filterEvidence, TALENT_POOL_FILTER_KEYS, "result.filterEvidence");
  if (input.filterEvidence.category !== "互联网技术其他") throw invalid("result filter evidence is not the approved talent pool category");
  if (!Array.isArray(input.items)) throw invalid("result.items must be an array");
  const batchSize = requireBoundedInteger(limits?.batchSize, "limits.batchSize", 1, 100);
  const maxPages = requireBoundedInteger(limits?.maxPages, "limits.maxPages", 1, 20);
  if (input.items.length > batchSize) throw invalid("result.items exceeds batchSize");
  const seen = new Set();
  const items = input.items.map((item, index) => {
    requirePlainObject(item, `result.items[${index}]`);
    requireOnlyKeys(item, TALENT_POOL_ITEM_KEYS, `result.items[${index}]`);
    const candidateId = requireIdentifier(item.candidateId, `result.items[${index}].candidateId`);
    if (seen.has(candidateId)) throw invalid("result.items contains duplicate candidateId");
    seen.add(candidateId);
    return {
      candidateId,
      realName: requireString(item.realName, `result.items[${index}].realName`),
      title: requireString(item.title, `result.items[${index}].title`),
      company: requireString(item.company, `result.items[${index}].company`, true),
      yearOfExperience: requireNullableNonNegativeInteger(item.yearOfExperience, `result.items[${index}].yearOfExperience`),
      age: requireNullableNonNegativeInteger(item.age, `result.items[${index}].age`),
      gender: requireString(item.gender, `result.items[${index}].gender`, true),
      city: requireString(item.city, `result.items[${index}].city`, true),
      education: requireString(item.education, `result.items[${index}].education`, true),
      pageNumber: requireBoundedInteger(item.pageNumber, `result.items[${index}].pageNumber`, 1, 10000),
      position: requireBoundedInteger(item.position, `result.items[${index}].position`, 1, 10000),
    };
  });
  requirePlainObject(input.page, "result.page");
  requireOnlyKeys(input.page, TALENT_POOL_PAGE_KEYS, "result.page");
  const page = {
    startPage: requireBoundedInteger(input.page.startPage, "result.page.startPage", 1, 10000),
    startOffset: requireBoundedInteger(input.page.startOffset, "result.page.startOffset", 0, 10000),
    endPage: requireBoundedInteger(input.page.endPage, "result.page.endPage", 1, 10000),
    pagesVisited: requireBoundedInteger(input.page.pagesVisited, "result.page.pagesVisited", 1, maxPages),
    nextPage: input.page.nextPage === null ? null : requireBoundedInteger(input.page.nextPage, "result.page.nextPage", 1, 10000),
    nextOffset: input.page.nextOffset === null ? null : requireBoundedInteger(input.page.nextOffset, "result.page.nextOffset", 0, 10000),
    stopReason: input.page.stopReason,
  };
  if (!LIST_STOP_REASONS.has(page.stopReason) || page.endPage < page.startPage) throw invalid("result.page is invalid");
  const contentHash = requireString(input.contentHash, "result.contentHash");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw invalid("result.contentHash must be lowercase sha256 hex");
  return {
    contractId: input.contractId, contractVersion: input.contractVersion, status: input.status,
    source, filterEvidence: { ...input.filterEvidence }, items, page, contentHash,
    nextPage: page.nextPage, nextOffset: page.nextOffset, stopReason: page.stopReason, pagesVisited: page.pagesVisited,
  };
}

/**
 * 严格解析候选人画像详情回执。真实姓名进入内部 candidates（RBAC + 加密 + 审计），
 * 但联系方式与简历正文白名单外键必须失败关闭，不进入 candidates / LLM 投影。
 */
export function parseCandidateDetailExtractionResult(input) {
  requirePlainObject(input, "result");
  rejectSensitiveKeys(input, "result");
  requireOnlyKeys(input, CANDIDATE_DETAIL_RESULT_KEYS, "result");
  if (input.contractId !== LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID || input.contractVersion !== LIEBIDE_CANDIDATE_DETAIL_CONTRACT_VERSION || input.status !== "extracted") throw invalid("candidate detail contract is unsupported");
  requirePlainObject(input.source, "result.source");
  requireOnlyKeys(input.source, SOURCE_KEYS, "result.source");
  if (input.source.origin !== LIEBIDE_PLATFORM_ORIGIN) throw invalid("result.source.origin is not allowed");
  const capturedAt = requireIsoDate(input.source.capturedAt, "result.source.capturedAt");
  requirePlainObject(input.record, "result.record");
  requireOnlyKeys(input.record, CANDIDATE_RECORD_KEYS, "result.record");
  const record = input.record;
  rejectForbiddenKeys(record, "result.record", CANDIDATE_FORBIDDEN_KEYS);
  const workExperiences = Array.isArray(record.workExperiences) ? record.workExperiences.map((entry, index) => {
    requirePlainObject(entry, `result.record.workExperiences[${index}]`);
    requireOnlyKeys(entry, WORK_EXPERIENCE_KEYS, `result.record.workExperiences[${index}]`);
    return {
      company: requireString(entry.company, `result.record.workExperiences[${index}].company`, true),
      title: requireString(entry.title, `result.record.workExperiences[${index}].title`, true),
    };
  }) : [];
  const contentHash = requireString(input.contentHash, "result.contentHash");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw invalid("result.contentHash must be lowercase sha256 hex");
  return {
    contractId: input.contractId, contractVersion: input.contractVersion, status: input.status,
    sourceOrigin: input.source.origin, capturedAt, contentHash,
    candidateId: requireIdentifier(record.candidateId, "result.record.candidateId"),
    realName: requireString(record.realName, "result.record.realName"),
    title: requireString(record.title, "result.record.title"),
    company: requireString(record.company, "result.record.company", true),
    yearOfExperience: requireNullableNonNegativeInteger(record.yearOfExperience, "result.record.yearOfExperience"),
    cityName: requireString(record.cityName, "result.record.cityName", true),
    school: requireString(record.school, "result.record.school", true),
    major: requireString(record.major, "result.record.major", true),
    degree: requireString(record.degree, "result.record.degree", true),
    completion: record.completion === null ? null : requireBoundedInteger(record.completion, "result.record.completion", 0, 100),
    recommendationCount: requireNullableNonNegativeInteger(record.recommendationCount, "result.record.recommendationCount"),
    workExperiences,
  };
}

function rejectForbiddenKeys(value, path, forbidden) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${path}[${index}]`, forbidden));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw invalid(`${path}.${key} is forbidden`);
    rejectForbiddenKeys(child, `${path}.${key}`, forbidden);
  }
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

function requireTitle(value, path, code) {
  if (typeof value !== "string") {
    throw new BrowserCollectionContractError(`${path} must be a string`, code);
  }
  const normalized = value.trim();
  if (normalized === "") {
    throw new BrowserCollectionContractError(`${path} must not be empty`, code);
  }
  if (normalized.length > 500) {
    throw new BrowserCollectionContractError(`${path} is too long`, code);
  }
  return normalized;
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

function requireBoundedInteger(value, path, min, max, code) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BrowserCollectionContractError(`${path} must be an integer between ${min} and ${max}`, code);
  }
  return value;
}

function invalid(message) {
  return new BrowserCollectionContractError(message);
}
