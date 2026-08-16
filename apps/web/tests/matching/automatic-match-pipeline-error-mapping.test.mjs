import assert from "node:assert/strict";
import test from "node:test";

import { LlmDetailScoringError } from "../../lib/adapters/llm-detail-scoring-adapter.mjs";
import {
  classifyScoreError,
  resolveDetailScoringAdapter,
} from "../../lib/jobs/automatic-match-pipeline.mjs";

function llmEnv() {
  return {
    APP_ENV: "test",
    MATCH_SCORING_ADAPTER: "llm-openai-compatible",
    LLM_BASE_URL: "https://llm.example.com/v1",
    LLM_MODEL: "test-model",
    LLM_API_KEY: "sk-test",
  };
}

test("classifyScoreError：error.code 优先于 message（真实适配器抛 LlmDetailScoringError）", () => {
  const err = new LlmDetailScoringError("LLM_RATE_LIMITED", { code: "LLM_RATE_LIMITED", retryable: true });
  assert.equal(classifyScoreError(err), "LLM_RATE_LIMITED");
  assert.equal(classifyScoreError(new LlmDetailScoringError("x", { code: "LLM_TIMEOUT" })), "LLM_TIMEOUT");
  assert.equal(classifyScoreError({ code: "LLM_UNAVAILABLE" }), "LLM_UNAVAILABLE");
});

test("classifyScoreError：白名单外 code → LLM_INTERNAL_ERROR", () => {
  assert.equal(classifyScoreError({ code: "NOT_A_LLM_CODE" }), "LLM_INTERNAL_ERROR");
});

test("classifyScoreError：message 兜底保留既有两个机器码", () => {
  assert.equal(classifyScoreError(new Error("LLM_OUTPUT_SCHEMA_INVALID")), "LLM_OUTPUT_SCHEMA_INVALID");
  assert.equal(classifyScoreError(new Error("NO_ASSESSABLE_DIMENSIONS")), "NO_ASSESSABLE_DIMENSIONS");
  assert.equal(classifyScoreError(new Error("anything else")), "LLM_INTERNAL_ERROR");
  assert.equal(classifyScoreError("string"), "LLM_INTERNAL_ERROR");
  assert.equal(classifyScoreError(undefined), "LLM_INTERNAL_ERROR");
});

test("resolveDetailScoringAdapter：test 无配置 / fake → fake 适配器", () => {
  const byDefault = resolveDetailScoringAdapter({ APP_ENV: "test" }, undefined);
  assert.equal(byDefault.metadata.adapterId, "fake-detail-scoring");
  const byName = resolveDetailScoringAdapter({ APP_ENV: "test", MATCH_SCORING_ADAPTER: "fake" }, undefined);
  assert.equal(byName.metadata.adapterId, "fake-detail-scoring");
});

test("resolveDetailScoringAdapter：llm-openai-compatible + 合法 env → 真实适配器", () => {
  const adapter = resolveDetailScoringAdapter(llmEnv(), undefined);
  assert.equal(adapter.metadata.adapterId, "llm-openai-compatible");
  assert.equal(adapter.metadata.promptVersion, "match-detail-prompt/v1");
});

test("resolveDetailScoringAdapter：llm-openai-compatible + 非法 env → LLM_ADAPTER_CONFIG_INVALID", () => {
  assert.throws(
    () => resolveDetailScoringAdapter({ APP_ENV: "test", MATCH_SCORING_ADAPTER: "llm-openai-compatible", LLM_MODEL: "m" }, undefined),
    (err) => err instanceof LlmDetailScoringError && err.code === "LLM_ADAPTER_CONFIG_INVALID",
  );
});

test("resolveDetailScoringAdapter：未知值 → null；production 无配置 → null", () => {
  assert.equal(resolveDetailScoringAdapter({ APP_ENV: "test", MATCH_SCORING_ADAPTER: "bogus" }, undefined), null);
  assert.equal(resolveDetailScoringAdapter({ APP_ENV: "production" }, undefined), null);
});
