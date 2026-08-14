import assert from "node:assert/strict";
import test from "node:test";

import {
  AGGREGATION_RULE_VERSION,
  aggregateDetailScore,
  deriveMatchRuleVersion,
} from "../../lib/matching/aggregate-detail-score.mjs";

const dimensions = [
  ["skills", 90], ["industry", 80], ["seniority", 80], ["experience", 90],
  ["location", 100], ["salary", 70], ["activity", null],
].map(([dimension, score]) => ({
  dimension,
  assessable: score !== null,
  score,
  confidence: score === null ? 0 : 0.8,
  evidence: score === null ? [] : [{ candidate_fact: "候选事实", job_requirement: "岗位要求", assessment: "可复核判断" }],
}));

test("本地汇总：忽略不可评估维度后重归一权重，结果可复算", async () => {
  const score = { dimensions, missing_items: ["活跃度缺失"], risks: [], overall_confidence: 0.7 };
  const first = await aggregateDetailScore(score);
  assert.deepEqual(first, await aggregateDetailScore(score));
  assert.equal(first.score, 87);
  assert.equal(first.band, "high");
  assert.equal(first.aggregationRuleVersion, AGGREGATION_RULE_VERSION);
  assert.deepEqual(first.missing, ["活跃度缺失"]);
});

test("匹配规则整数由完整版本束稳定派生，版本变化不会覆盖旧 match", async () => {
  const base = {
    projectionInputHash: "a".repeat(64),
    filterRuleVersion: "v1", adapterId: "fake", adapterVersion: "1",
    modelId: "fake-detail-v1", modelRevision: "fixture", promptVersion: "prompt/v1",
    schemaVersion: "llm-detail-score/v1", aggregationRuleVersion: "aggregation/v1",
  };
  assert.equal(await deriveMatchRuleVersion(base), await deriveMatchRuleVersion(base));
  assert.notEqual(
    await deriveMatchRuleVersion(base),
    await deriveMatchRuleVersion({ ...base, promptVersion: "prompt/v2" }),
  );
  assert.notEqual(
    await deriveMatchRuleVersion(base),
    await deriveMatchRuleVersion({ ...base, projectionInputHash: "b".repeat(64) }),
  );
});
