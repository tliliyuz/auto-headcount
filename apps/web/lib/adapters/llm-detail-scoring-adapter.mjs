/**
 * 生产 LLM 详情评分适配器（M3 阶段二，docs/10 §6，docs/02 §4 供应商隔离适配器端口）。
 *
 * 供应商无关 + 配置驱动：env 提供 baseURL/model/apiKey/超时等，v1 默认走
 * OpenAI-compatible `chat/completions` wire format（覆盖 DeepSeek/Qwen/GLM 等境内
 * 与多数兼容网关，temperature 可配最低随机性）。真实供应商接线受合规门禁阻塞
 * （docs/01 §3、docs/06 §敏感业务、ADR-005：供应商/模型、处理区域、数据不用于训练、
 * 预算、超时上限未审批前真实 LLM 调用保持关闭）——本模块本身 fail-closed：
 * 配置不完整 → `LLM_ADAPTER_CONFIG_INVALID`；生产未配置/未知适配器 → 管线
 * `LLM_ADAPTER_NOT_CONFIGURED`。生产绝不回退 Fake。
 *
 * 安全边界（docs/10 §4.1/§6、docs/06 §敏感业务）：只透传已 `residual_pii_scan=passed`
 * 的脱敏投影（job-requirement-projection/v1 + candidate-match-projection/v1 的
 * profile 与 redacted_detail），不增补姓名/联系方式/详细地址/本地或供应商 ID/原始
 * URL/令牌；`request_item_id` 回显输入。Prompt 遵循 `match-detail-prompt/v1` 规范性
 * 行为（不推断身份属性、缺失不当负面、不可评估维度 score:null、不输出总分/分档/决策）。
 *
 * 错误语义（docs/10 §6.3）：抛 `LlmDetailScoringError`（message=机器码，供管线
 * `classifyScoreError` 落 `llm_score_runs.error_code`）。超时/限流/不可用/内部错误可
 * 重试（SQL retryable 白名单）；认证失败/输入超限/安全拒绝/Schema 无效 terminal。
 */

import { createHash } from "node:crypto";

export const LLM_DETAIL_SCORE_DIMENSIONS = Object.freeze([
  "skills",
  "industry",
  "seniority",
  "experience",
  "location",
  "salary",
  "activity",
]);
export const LLM_DETAIL_SCORING_ADAPTER_ID = "llm-openai-compatible";
export const LLM_DETAIL_SCORING_SCHEMA_VERSION = "llm-detail-score/v1";
export const LLM_DETAIL_PROMPT_VERSION = "match-detail-prompt/v1";
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_TEMPERATURE = 0;
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 2048;

const REQUEST_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

/**
 * `match-detail-prompt/v1`：不可变 Prompt 模板。任何文字/排序变更必须升级
 * `prompt_version`（docs/10 §6.1），并同时更新此处常量与 metadata。
 */
export const MATCH_DETAIL_PROMPT_V1 = Object.freeze(
  `你是职位-候选人匹配评估器。严格依据给定的脱敏投影评估，禁止：
- 推断姓名、性别、年龄、民族、婚育、健康等身份属性；
- 把缺失信息当作负面事实；
- 输出 total_score、分档 band、是否录用/触达等任何自动决策。

对证据不足的维度返回 assessable:false 且 score:null，禁止猜分。
只输出 llm-detail-score/v1 JSON，结构如下（七个维度必须各恰好出现一次）：
{
  "schema_version": "llm-detail-score/v1",
  "request_item_id": "<回显输入 id>",
  "dimensions": [
    {
      "dimension": "skills 或 industry 或 seniority 或 experience 或 location 或 salary 或 activity",
      "assessable": true,
      "score": "0-100 整数",
      "confidence": "0-1",
      "evidence": [ { "candidate_fact": "候选人脱敏事实", "job_requirement": "对应职位要求", "assessment": "评估结论" } ]
    }
  ],
  "missing_items": ["无法评估维度的人类可读说明"],
  "risks": [],
  "overall_confidence": "0-1"
}
assessable:false 时 score 必须为 null 且 evidence 为空数组。`,
);

export class LlmDetailScoringError extends Error {
  constructor(message, { code, status, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "LlmDetailScoringError";
    this.code = code ?? "LLM_INTERNAL_ERROR";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 读取并校验 LLM 适配器配置。必填：LLM_BASE_URL（https 或 localhost http）、
 * LLM_MODEL、LLM_API_KEY；可选：LLM_PROVIDER（仅登记标识）、LLM_TIMEOUT_MS、
 * LLM_TEMPERATURE、LLM_MAX_OUTPUT_TOKENS。校验失败抛
 * `LLM_ADAPTER_CONFIG_INVALID`（错误 message 不含 apiKey 值）。
 */
export function loadLlmDetailScoringConfig(env = process.env) {
  const baseUrl = requiredString(env.LLM_BASE_URL, "LLM_BASE_URL");
  const model = requiredString(env.LLM_MODEL, "LLM_MODEL");
  const apiKey = requiredString(env.LLM_API_KEY, "LLM_API_KEY");
  const timeoutMs = parseBoundedInt(
    env.LLM_TIMEOUT_MS,
    "LLM_TIMEOUT_MS",
    100,
    120_000,
    DEFAULT_LLM_TIMEOUT_MS,
  );
  const temperature = parseBoundedNumber(
    env.LLM_TEMPERATURE,
    "LLM_TEMPERATURE",
    0,
    2,
    DEFAULT_LLM_TEMPERATURE,
  );
  const maxOutputTokens = parseBoundedInt(
    env.LLM_MAX_OUTPUT_TOKENS,
    "LLM_MAX_OUTPUT_TOKENS",
    64,
    128_000,
    DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  );

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw configError("LLM_BASE_URL must be a valid URL");
  }
  const isLocalHttp =
    parsedUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== "https:" && !isLocalHttp) {
    throw configError("LLM_BASE_URL must use HTTPS unless it is local");
  }

  return {
    provider: env.LLM_PROVIDER?.trim() ?? "",
    baseUrl: parsedUrl.href.replace(/\/+$/, ""),
    model,
    apiKey,
    timeoutMs,
    temperature,
    maxOutputTokens,
  };
}

/**
 * 适配器工厂。`fetchImpl` 供测试注入 mock HTTP；真实调用保持 fail-closed。
 * 实现评分端口（docs/10 §6）：`{ metadata, score(input) }`，与 fake 同形状。
 */
export function createLlmDetailScoringAdapter(
  env = process.env,
  { fetchImpl = globalThis.fetch } = {},
) {
  const config = loadLlmDetailScoringConfig(env);
  if (typeof fetchImpl !== "function") {
    throw configError("LLM fetch implementation required");
  }
  const metadata = Object.freeze({
    adapterId: LLM_DETAIL_SCORING_ADAPTER_ID,
    adapterVersion: "1",
    modelId: config.model,
    modelRevision: null, // 供应商无可靠修订 → null（docs/10 §6.1 允许）
    promptVersion: LLM_DETAIL_PROMPT_VERSION,
    schemaVersion: LLM_DETAIL_SCORING_SCHEMA_VERSION,
  });

  return {
    metadata,
    async score(input) {
      const body = buildChatCompletionRequest(input, config);
      const response = await callChatCompletion(config, body, fetchImpl);
      const document = await parseScoreResponse(response);
      assertLlmDetailScoreSemantics(document);
      return document;
    },
  };
}

/**
 * 语义校验：七维各恰一次 + request_item_id 符合 pattern。
 * `validateLlmDetailScore` 只做 JSON Schema（dimensions 无 uniqueItems），
 * 重复/缺失维度 schema 拦不住——本函数在适配器内前置兜底。
 */
export function assertLlmDetailScoreSemantics(document) {
  if (!document || !Array.isArray(document.dimensions)) {
    throw schemaInvalid("llm-detail-score/v1 missing dimensions array");
  }
  if (document.dimensions.length !== LLM_DETAIL_SCORE_DIMENSIONS.length) {
    throw schemaInvalid("dimensions must contain exactly 7 entries");
  }
  const seen = new Set();
  for (const item of document.dimensions) {
    const dimension = item?.dimension;
    if (!LLM_DETAIL_SCORE_DIMENSIONS.includes(dimension)) {
      throw schemaInvalid(`unknown dimension: ${dimension}`);
    }
    if (seen.has(dimension)) {
      throw schemaInvalid(`duplicate dimension: ${dimension}`);
    }
    seen.add(dimension);
  }
  if (seen.size !== LLM_DETAIL_SCORE_DIMENSIONS.length) {
    throw schemaInvalid("dimensions must each appear exactly once");
  }
  if (
    typeof document.request_item_id !== "string" ||
    !REQUEST_ITEM_ID_PATTERN.test(document.request_item_id)
  ) {
    throw schemaInvalid("request_item_id must match ^[A-Za-z0-9_-]{16,100}$");
  }
}

/** 回显 request_item_id：非法字符替换；<16 位时用内容哈希派生合法 id（≥16 位）。 */
export function normalizeRequestItemId(value) {
  const raw = String(value ?? "");
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  if (cleaned.length >= 16) return cleaned;
  return `item_${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function buildChatCompletionRequest(input, config) {
  const payload = {
    schema_version: LLM_DETAIL_SCORING_SCHEMA_VERSION,
    request_item_id: normalizeRequestItemId(input?.requestItemId),
    job_projection: input?.jobProjection ?? null,
    candidate_projection: {
      profile: input?.candidateProjection?.profile ?? null,
      redacted_detail: input?.candidateProjection?.redactedDetail ?? null,
    },
  };
  return {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    stream: false,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: MATCH_DETAIL_PROMPT_V1 },
      { role: "user", content: JSON.stringify(payload) },
    ],
  };
}

async function callChatCompletion(config, body, fetchImpl) {
  const endpoint = `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new LlmDetailScoringError("LLM request timed out", {
        code: "LLM_TIMEOUT",
        retryable: true,
        cause: error,
      });
    }
    throw new LlmDetailScoringError("LLM network request failed", {
      code: "LLM_UNAVAILABLE",
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw await classifyHttpError(response);
  return response;
}

async function classifyHttpError(response) {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new LlmDetailScoringError("LLM authentication failed", {
      code: "LLM_AUTH_FAILED",
      status,
    });
  }
  if (status === 429) {
    return new LlmDetailScoringError("LLM rate limit exceeded", {
      code: "LLM_RATE_LIMITED",
      status,
      retryable: true,
    });
  }
  if (status === 413) {
    return new LlmDetailScoringError("LLM input too large", {
      code: "LLM_INPUT_TOO_LARGE",
      status,
    });
  }
  if (status >= 500) {
    return new LlmDetailScoringError("LLM unavailable", {
      code: "LLM_UNAVAILABLE",
      status,
      retryable: true,
    });
  }
  // 400 等：读 body 细分 context/token 超限 vs 内容安全拒绝。
  const bodyText = await readResponseText(response);
  if (/context|token|length|size|too large|limit/i.test(bodyText)) {
    return new LlmDetailScoringError("LLM input too large", {
      code: "LLM_INPUT_TOO_LARGE",
      status,
    });
  }
  if (/content.?policy|safety|refus|moderation|violat/i.test(bodyText)) {
    return new LlmDetailScoringError("LLM safety refusal", {
      code: "LLM_SAFETY_REFUSAL",
      status,
    });
  }
  return new LlmDetailScoringError("LLM unavailable", {
    code: "LLM_UNAVAILABLE",
    status,
    retryable: true,
  });
}

async function readResponseText(response) {
  try {
    if (typeof response.json === "function") {
      const json = await response.json();
      return typeof json === "string" ? json : JSON.stringify(json);
    }
  } catch {
    // 继续尝试 text()
  }
  try {
    if (typeof response.text === "function") return await response.text();
  } catch {
    // 无 body
  }
  return "";
}

async function parseScoreResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw schemaInvalid("LLM response was not valid JSON");
  }
  // ① OpenAI chat/completions 信封。
  if (Array.isArray(body?.choices)) {
    const first = body.choices[0];
    if (first?.finish_reason === "content_filter") {
      throw new LlmDetailScoringError("LLM content safety refusal", {
        code: "LLM_SAFETY_REFUSAL",
      });
    }
    const content = first?.message?.content ?? first?.text ?? null;
    if (typeof content === "string") {
      try {
        return JSON.parse(content);
      } catch {
        throw schemaInvalid("LLM content was not valid llm-detail-score JSON");
      }
    }
    if (content && typeof content === "object") return content;
    throw schemaInvalid("LLM response choices missing content");
  }
  // ② 网关/mock 直出 llm-detail-score/v1。
  if (body?.schema_version === LLM_DETAIL_SCORING_SCHEMA_VERSION) return body;
  throw schemaInvalid(
    "LLM response is neither llm-detail-score/v1 nor OpenAI chat/completions",
  );
}

function schemaInvalid(message) {
  return new LlmDetailScoringError(message, {
    code: "LLM_OUTPUT_SCHEMA_INVALID",
  });
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${name} is required`);
  }
  return value.trim();
}

function parseBoundedInt(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw configError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoundedNumber(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw configError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function configError(message) {
  return new LlmDetailScoringError(message, {
    code: "LLM_ADAPTER_CONFIG_INVALID",
  });
}
