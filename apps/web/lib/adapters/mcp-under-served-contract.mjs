export class McpContractError extends Error {
  constructor(message, code = "MCP_CONTRACT_INVALID") {
    super(message);
    this.name = "McpContractError";
    this.code = code;
  }
}

/**
 * 权限边界业务码：供应商语义上属「越权/数据范围之外」而非瞬时故障
 * （docs/04 §4「403、业务错误 1004 或空结果按权限边界处理」；实测 match_candidates 返回 1003）。
 * 调用方据此不重试、不换身份。
 */
export const PERMISSION_BOUNDARY_CODES = new Set([403, 1003, 1004]);

export function parseUnderServedJobsResult(result) {
  if (!isObject(result) || !Array.isArray(result.content)) {
    throw invalid("content must be an array");
  }
  if (result.isError === true) {
    throw new McpContractError(
      "MCP tool reported an error",
      "MCP_UPSTREAM_ERROR",
    );
  }

  const textBlock = result.content.find(
    (item) => isObject(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!textBlock) throw invalid("content has no text result");

  let payload;
  try {
    payload = JSON.parse(textBlock.text);
  } catch {
    throw invalid("text result is not valid JSON");
  }

  if (!isObject(payload)) throw invalid("payload must be an object");
  requireNumber(payload.Code, "Code");
  requireString(payload.Message, "Message");
  if (payload.Code !== 0) {
    throw new McpContractError(
      "MCP provider returned a business error",
      PERMISSION_BOUNDARY_CODES.has(payload.Code)
        ? "MCP_PERMISSION_BOUNDARY"
        : "MCP_UPSTREAM_ERROR",
    );
  }
  if (!isObject(payload.Data)) throw invalid("Data must be an object");

  const data = payload.Data;
  const total = requireNonNegativeInteger(data.total, "Data.total");
  const page = requirePositiveInteger(data.page, "Data.page");
  const pageSize = requirePositiveInteger(data.page_size, "Data.page_size");
  const totalPages = requireNonNegativeInteger(
    data.total_pages,
    "Data.total_pages",
  );
  if (!Array.isArray(data.list)) throw invalid("Data.list must be an array");

  return {
    total,
    page,
    pageSize,
    totalPages,
    jobs: data.list.map((item, index) => mapJob(item, index)),
    rawItems: data.list,
  };
}

export function selectEligibleUnderServedJobs(page) {
  if (!isObject(page) || !Array.isArray(page.jobs)) {
    throw invalid("normalized page must contain jobs");
  }
  return page.jobs.filter(isEligibleAge);
}

export function selectEligibleUnderServedPairs(page) {
  if (
    !isObject(page) ||
    !Array.isArray(page.jobs) ||
    !Array.isArray(page.rawItems)
  ) {
    throw invalid("normalized page must contain jobs and rawItems");
  }
  if (page.jobs.length !== page.rawItems.length) {
    throw invalid("jobs and rawItems must have the same length");
  }
  const pairs = [];
  for (let index = 0; index < page.jobs.length; index += 1) {
    const job = page.jobs[index];
    if (isEligibleAge(job)) {
      pairs.push({ job, rawItem: page.rawItems[index], index });
    }
  }
  return pairs;
}

function isEligibleAge(job) {
  return Number.isInteger(job.ageDays) && job.ageDays >= 7 && job.ageDays <= 30;
}

function mapJob(item, index) {
  const path = `Data.list[${index}]`;
  if (!isObject(item)) throw invalid(`${path} must be an object`);

  return {
    externalId: requireString(item.job_id, `${path}.job_id`),
    title: requireString(item.job_title, `${path}.job_title`),
    companyName: requireCompanyOrCityString(
      item.client_company,
      `${path}.client_company`,
    ),
    ownerExternalId: requireString(item.owner_id, `${path}.owner_id`),
    ownerName: requireString(item.owner_name, `${path}.owner_name`),
    ageDays: requireNonNegativeInteger(
      item.days_without_rec,
      `${path}.days_without_rec`,
    ),
    lastRecommendationAt: requireNullableString(
      item.last_rec_date,
      `${path}.last_rec_date`,
    ),
    category: requireString(item.category, `${path}.category`),
    city: requireCompanyOrCityString(item.city, `${path}.city`),
    salaryMin: requireNullableNumber(item.salary_min, `${path}.salary_min`),
    salaryMax: requireNullableNumber(item.salary_max, `${path}.salary_max`),
    portalUrl: requireString(item.portal_url, `${path}.portal_url`),
    sourceCreatedAt: requireNullableString(
      item.created_at,
      `${path}.created_at`,
    ),
    eligibilityEvidence: {
      activeStatus: "provider_filter",
      zeroRecommendations: "provider_filter",
      age: "days_without_rec",
    },
  };
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${path} must be a non-empty string`);
  }
  return value;
}

/**
 * 公司/城市放宽校验：供应商已确认这些字段可为空（docs/04 实测「公司/薪资/城市为空」），
 * null/空串统一归一为空串（jobs.company_name/city 为 NOT NULL，避免入库约束失败）；
 * 非字符串仍拒绝（不静默吞类型漂移）。
 */
function requireCompanyOrCityString(value, path) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw invalid(`${path} must be a string or null`);
  }
  return value;
}

function requireNullableString(value, path) {
  if (value === null) return null;
  return requireString(value, path);
}

function requireNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(`${path} must be a number`);
  }
  return value;
}

function requireNullableNumber(value, path) {
  if (value === null) return null;
  return requireNumber(value, path);
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`${path} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value, path) {
  if (!Number.isInteger(value) || value < 1) {
    throw invalid(`${path} must be a positive integer`);
  }
  return value;
}

function invalid(message) {
  return new McpContractError(message);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
