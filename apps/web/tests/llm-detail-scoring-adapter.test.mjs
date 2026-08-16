import assert from "node:assert/strict";
import test from "node:test";

import {
  LLM_DETAIL_SCORING_ADAPTER_ID,
  LlmDetailScoringError,
  assertLlmDetailScoreSemantics,
  createLlmDetailScoringAdapter,
  loadLlmDetailScoringConfig,
  normalizeRequestItemId,
} from "../lib/adapters/llm-detail-scoring-adapter.mjs";
import { validateLlmDetailScore } from "../lib/matching/projection-schemas.mjs";

const DIMENSIONS = ["skills", "industry", "seniority", "experience", "location", "salary", "activity"];

function validScoreDocument(requestItemId) {
  return {
    schema_version: "llm-detail-score/v1",
    request_item_id: requestItemId,
    dimensions: DIMENSIONS.map((dimension) => ({
      dimension,
      assessable: true,
      score: 85,
      evidence: [
        { candidate_fact: "候选人具备该维度相关事实", job_requirement: "职位要求该维度", assessment: "评估认为匹配" },
      ],
      confidence: 0.8,
    })),
    missing_items: [],
    risks: [],
    overall_confidence: 0.8,
  };
}

function openaiEnvelope(doc) {
  return {
    choices: [
      { message: { role: "assistant", content: JSON.stringify(doc) }, finish_reason: "stop" },
    ],
    usage: {},
  };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, headers: { get: () => null } };
}
function httpError(status, errorBody = { error: { message: "provider error", code: "x" } }) {
  return {
    ok: false,
    status,
    json: async () => errorBody,
    headers: { get: () => null },
  };
}

const REQUEST_ITEM_ID = "item_1234567890abcdef12345678";
const INPUT = {
  requestItemId: REQUEST_ITEM_ID,
  jobProjection: {
    hard_requirements: { required_skills: ["Node.js"], locations: ["上海"] },
    scoring_context: { industry: "互联网", seniority: "高级" },
  },
  candidateProjection: {
    profile: { skills: ["Node.js"], city: "上海", experience_years: 6, seniority: "高级" },
    redactedDetail: { career_history: ["某公司 · 高级工程师"], project_highlights: [] },
  },
};

function configEnv(overrides = {}) {
  return {
    APP_ENV: "test",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_MODEL: "test-model",
    LLM_API_KEY: "sk-test-secret-value",
    ...overrides,
  };
}

test("适配器模块加载：metadata 六键全字符串，adapterId/promptVersion/schemaVersion 固定", () => {
  const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl: () => okJson(openaiEnvelope(validScoreDocument(REQUEST_ITEM_ID))) });
  const m = adapter.metadata;
  assert.equal(m.adapterId, LLM_DETAIL_SCORING_ADAPTER_ID);
  assert.equal(m.adapterVersion, "1");
  assert.equal(m.modelId, "test-model");
  assert.equal(m.modelRevision, null);
  assert.equal(m.promptVersion, "match-detail-prompt/v2");
  assert.equal(m.schemaVersion, "llm-detail-score/v1");
  assert.equal(Object.keys(m).length, 6);
});

test("score：OpenAI chat/completions 信封解析出 llm-detail-score/v1，过 Schema，七维各恰一次，request_item_id 回显", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return okJson(openaiEnvelope(validScoreDocument(REQUEST_ITEM_ID)));
  };
  const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl });
  const result = await adapter.score(INPUT);

  assert.equal(result.schema_version, "llm-detail-score/v1");
  assert.equal(result.request_item_id, REQUEST_ITEM_ID);
  assert.equal(result.dimensions.length, 7);
  assert.deepEqual(result.dimensions.map((d) => d.dimension), DIMENSIONS);
  const validated = await validateLlmDetailScore(result);
  assert.equal(validated.ok, true);

  // 请求断言：model / temperature:0 / Bearer 头 / URL
  assert.equal(captured.url, "https://llm.example.com/v1/chat/completions");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  const payload = JSON.parse(body.messages[1].content);
  assert.equal(payload.request_item_id, REQUEST_ITEM_ID);
  assert.equal(payload.candidate_projection.redacted_detail.career_history[0], "某公司 · 高级工程师");
  // 请求不得携带姓名/ID/URL 等敏感字段
  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes("displayName") && !raw.includes("externalId") && !raw.includes("http"), "请求不得含敏感标识");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test-secret-value");
});

test("score：返回体直出 llm-detail-score/v1（网关直出）时透传", async () => {
  const doc = validScoreDocument(REQUEST_ITEM_ID);
  const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl: () => okJson(doc) });
  const result = await adapter.score(INPUT);
  assert.equal(result.request_item_id, REQUEST_ITEM_ID);
  assert.equal(result.dimensions.length, 7);
});

test("HTTP 429 → LLM_RATE_LIMITED 且 retryable", async () => {
  const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl: () => httpError(429) });
  await assert.rejects(
    () => adapter.score(INPUT),
    (err) => {
      assert.ok(err instanceof LlmDetailScoringError);
      assert.equal(err.code, "LLM_RATE_LIMITED");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("fetch Abort → LLM_TIMEOUT 且 retryable", async () => {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const adapter = createLlmDetailScoringAdapter(configEnv(), {
    fetchImpl: async () => {
      throw abortError;
    },
  });
  await assert.rejects(
    () => adapter.score(INPUT),
    (err) => {
      assert.equal(err.code, "LLM_TIMEOUT");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("HTTP 500 → LLM_UNAVAILABLE 且 retryable", async () => {
  const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl: () => httpError(500) });
  await assert.rejects(
    () => adapter.score(INPUT),
    (err) => {
      assert.equal(err.code, "LLM_UNAVAILABLE");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("HTTP 401/403 → LLM_AUTH_FAILED 且非 retryable", async () => {
  for (const status of [401, 403]) {
    const adapter = createLlmDetailScoringAdapter(configEnv(), { fetchImpl: () => httpError(status) });
    await assert.rejects(
      () => adapter.score(INPUT),
      (err) => {
        assert.equal(err.code, "LLM_AUTH_FAILED");
        assert.equal(err.retryable, false);
        return true;
      },
    );
  }
});

test("HTTP 400 context/token 语义 → LLM_INPUT_TOO_LARGE", async () => {
  const adapter = createLlmDetailScoringAdapter(configEnv(), {
    fetchImpl: () =>
      httpError(400, { error: { message: "This model's maximum context length is 128000 tokens" } }),
  });
  await assert.rejects(
    () => adapter.score(INPUT),
    (err) => {
      assert.equal(err.code, "LLM_INPUT_TOO_LARGE");
      return true;
    },
  );
});

test("finish_reason=content_filter → LLM_SAFETY_REFUSAL", async () => {
  const adapter = createLlmDetailScoringAdapter(configEnv(), {
    fetchImpl: () =>
      okJson({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }] }),
  });
  await assert.rejects(
    () => adapter.score(INPUT),
    (err) => {
      assert.equal(err.code, "LLM_SAFETY_REFUSAL");
      return true;
    },
  );
});

test("assertLlmDetailScoreSemantics：七维重复/缺失/枚举外 → LLM_OUTPUT_SCHEMA_INVALID", () => {
  const dup = validScoreDocument(REQUEST_ITEM_ID);
  dup.dimensions[1].dimension = "skills";
  assert.throws(() => assertLlmDetailScoreSemantics(dup), (err) => err.code === "LLM_OUTPUT_SCHEMA_INVALID");

  const missing = validScoreDocument(REQUEST_ITEM_ID);
  missing.dimensions = missing.dimensions.slice(0, 6);
  assert.throws(() => assertLlmDetailScoreSemantics(missing), (err) => err.code === "LLM_OUTPUT_SCHEMA_INVALID");

  const badEnum = validScoreDocument(REQUEST_ITEM_ID);
  badEnum.dimensions[0].dimension = "not_a_dimension";
  assert.throws(() => assertLlmDetailScoreSemantics(badEnum), (err) => err.code === "LLM_OUTPUT_SCHEMA_INVALID");
});

test("assertLlmDetailScoreSemantics：request_item_id 不符合 pattern → LLM_OUTPUT_SCHEMA_INVALID", () => {
  const doc = validScoreDocument("too-short");
  assert.throws(() => assertLlmDetailScoreSemantics(doc), (err) => err.code === "LLM_OUTPUT_SCHEMA_INVALID");
});

test("loadLlmDetailScoringConfig：缺 baseUrl/model/key、非 https 非 localhost → LLM_ADAPTER_CONFIG_INVALID 且 message 不含 apiKey", () => {
  assert.throws(() => loadLlmDetailScoringConfig({ LLM_MODEL: "m", LLM_API_KEY: "k" }), (err) => {
    assert.equal(err.code, "LLM_ADAPTER_CONFIG_INVALID");
    assert.ok(!String(err.message).includes("sk-test-secret-value"));
    return true;
  });
  assert.throws(() => loadLlmDetailScoringConfig({ LLM_BASE_URL: "https://x", LLM_API_KEY: "k" }), (err) => err.code === "LLM_ADAPTER_CONFIG_INVALID");
  assert.throws(() => loadLlmDetailScoringConfig({ LLM_BASE_URL: "https://x", LLM_MODEL: "m" }), (err) => err.code === "LLM_ADAPTER_CONFIG_INVALID");
  assert.throws(
    () => loadLlmDetailScoringConfig(configEnv({ LLM_BASE_URL: "http://insecure.example.com" })),
    (err) => err.code === "LLM_ADAPTER_CONFIG_INVALID",
  );
  const ok = loadLlmDetailScoringConfig(configEnv());
  assert.equal(ok.model, "test-model");
  assert.equal(ok.timeoutMs, 60000);
});

test("normalizeRequestItemId：非法字符替换 + 长度下限（<16 位用内容哈希派生）", () => {
  assert.equal(normalizeRequestItemId("item/with spaces!"), "item_with_spaces_");
  const derived = normalizeRequestItemId("item_abcdef");
  assert.ok(/^[A-Za-z0-9_-]{16,100}$/.test(derived));
  assert.equal(normalizeRequestItemId(REQUEST_ITEM_ID), REQUEST_ITEM_ID);
});
