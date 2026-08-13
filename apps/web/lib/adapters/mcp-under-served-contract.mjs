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

/**
 * 解析 `wb.jobs.list` 响应：只取补全 JD 所需的 `{ externalId, jobDescription }`。
 * 其余字段（salary/customer_name/department_path/created_by/status 等）不进入业务模型，
 * 仅由夹具保存形状；job_description 为空串/缺失归一为 null（无 JD 占位）。
 * 包络校验、业务错误码与权限边界码（403/1003/1004）语义与 `parseUnderServedJobsResult` 一致。
 */
export function parseJobsListResult(result) {
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
    jobs: data.list.map((item, index) => mapJobListItem(item, index)),
  };
}

function mapJobListItem(item, index) {
  const path = `Data.list[${index}]`;
  if (!isObject(item)) throw invalid(`${path} must be an object`);

  return {
    externalId: requireString(item.job_id, `${path}.job_id`),
    jobDescription: requireJobDescription(
      item.job_description,
      `${path}.job_description`,
    ),
  };
}

/**
 * 解析 `wb.jobs.get(job_id)` 响应：`Data` 为单个职位对象（非 list 包裹）。
 * 受控验证（2026-08-13）：get 对沉睡职位（含非账号可操作）均返回 Code=0 + job_description；
 * 权限边界码（403/1003/1004）映射 MCP_PERMISSION_BOUNDARY（不重试、不换身份）。
 * 仅提取 JD 所需字段，不投影其他原始字段。
 */
export function parseJobsGetResult(result) {
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
  return {
    externalId: requireString(data.job_id, "Data.job_id"),
    jobDescription: requireJobDescription(
      data.job_description,
      "Data.job_description",
    ),
  };
}

/**
 * 解析 `wb.jobs.match_candidates` 响应（内部运营只读投影，docs/04 §3 已确认字段）。
 * 评分以供应方为准（docs/01 §1.3）：`score_status` 为 `cached`/`pending`（LLM 打分中，**正常态**，
 * 后续轮询/重读）/`failed`（上游失败）；`total_score`/`tier` 在 pending 时为 null。
 * 权限边界码（403/1003/1004）映射 MCP_PERMISSION_BOUNDARY（可操作边界 = wb.jobs.list 作用域，
 * 对非自身职位不重试、不换身份）。
 * 投影收敛：只取候选人基础信息与打码名（不投影完整简历/联系方式——MVP 边界，见 docs/06）。
 */
export function parseMatchCandidatesResult(result) {
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
  if (!Array.isArray(data.matches)) throw invalid("Data.matches must be an array");

  return {
    sourceId: requireString(data.source_id, "Data.source_id"),
    sourceType: requireString(data.source_type, "Data.source_type"),
    total,
    page,
    pageSize,
    totalPages,
    matches: data.matches.map((item, index) => mapMatchCandidate(item, index)),
  };
}

function mapMatchCandidate(item, index) {
  const path = `Data.matches[${index}]`;
  if (!isObject(item)) throw invalid(`${path} must be an object`);

  const summary = isObject(item.candidate_summary) ? item.candidate_summary : null;
  return {
    candidateId: requireString(item.candidate_id, `${path}.candidate_id`),
    isOwn: item.is_own === true,
    ownerId: requireNullableString(item.owner_id, `${path}.owner_id`),
    ownerName: requireNullableString(item.owner_name, `${path}.owner_name`),
    scoreStatus: requireString(item.score_status, `${path}.score_status`),
    totalScore: requireNullableNumber(item.total_score, `${path}.total_score`),
    tier: requireNullableString(item.tier, `${path}.tier`),
    // M2 退出门禁（docs/05:190）要求证据/缺失项/风险提示三类信息——透传供应方解释字段。
    dimensionScores: parseDimensionScores(
      item.dimension_scores,
      `${path}.dimension_scores`,
    ),
    matchHighlights: requireStringArray(
      item.match_highlights,
      `${path}.match_highlights`,
    ),
    gapAnalysis: requireStringArray(item.gap_analysis, `${path}.gap_analysis`),
    riskFlags: requireStringArray(item.risk_flags, `${path}.risk_flags`),
    verificationSuggestions: requireStringArray(
      item.verification_suggestions,
      `${path}.verification_suggestions`,
    ),
    jobSummary: requireNullableString(item.job_summary, `${path}.job_summary`),
    candidate: summary
      ? {
          name: requireNullableString(summary.name, `${path}.candidate_summary.name`),
          currentTitle: requireNullableString(
            summary.current_title,
            `${path}.candidate_summary.current_title`,
          ),
          currentCompany: requireNullableString(
            summary.current_company,
            `${path}.candidate_summary.current_company`,
          ),
          city: requireNullableString(summary.city, `${path}.candidate_summary.city`),
          experienceYears: requireNullableNumber(
            summary.experience_years,
            `${path}.candidate_summary.experience_years`,
          ),
          resumeSummary: requireNullableString(
            summary.resume_summary,
            `${path}.candidate_summary.resume_summary`,
          ),
        }
      : null,
  };
}

/** 字符串数组（如 match_highlights/gap_analysis/risk_flags）；null/undefined 归一为 null。 */
function requireStringArray(value, path) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw invalid(`${path} must be an array or null`);
  return value.map((item, index) => {
    if (typeof item !== "string") throw invalid(`${path}[${index}] must be a string`);
    return item;
  });
}

/** 维度分：接受数组 [{dimension,score}] 或对象 {dimension:score}；null 归一为 null。 */
function parseDimensionScores(value, path) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (!isObject(item)) throw invalid(`${path}[${index}] must be an object`);
      return {
        dimension: requireString(
          item.dimension ?? item.name ?? `${index}`,
          `${path}[${index}].dimension`,
        ),
        score: requireNullableNumber(item.score, `${path}[${index}].score`),
      };
    });
  }
  if (isObject(value)) {
    return Object.entries(value).map(([dimension, score]) => ({
      dimension,
      score: requireNullableNumber(score, `${path}.${dimension}`),
    }));
  }
  throw invalid(`${path} must be an array, object, or null`);
}

/** 职位描述：null/undefined/空串归一为 null（无 JD），非字符串拒绝（不吞类型漂移）。 */
function requireJobDescription(value, path) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw invalid(`${path} must be a string or null`);
  }
  return value.trim() === "" ? null : value;
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
    companyName: requireStringOrEmpty(
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
    category: requireStringOrEmpty(item.category, `${path}.category`),
    city: requireStringOrEmpty(item.city, `${path}.city`),
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
 * 公司/城市/类别放宽校验：供应商实测这些字段可为空（docs/04「公司/薪资/城市为空」，
 * 真实数据 category 亦为空串），null/空串统一归一为空串（jobs.* 为 NOT NULL，避免入库约束失败）；
 * 非字符串仍拒绝（不静默吞类型漂移）。
 */
function requireStringOrEmpty(value, path) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw invalid(`${path} must be a string or null`);
  }
  return value;
}

function requireNullableString(value, path) {
  if (value === null || value === undefined) return null;
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
