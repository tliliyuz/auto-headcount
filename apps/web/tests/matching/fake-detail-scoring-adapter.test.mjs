import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";

import { createFakeDetailScoringAdapter } from "../../lib/matching/fake-detail-scoring-adapter.mjs";

const schema = JSON.parse(await readFile(
  new URL("../../../../docs/contracts/llm-detail-score.v1.schema.json", import.meta.url),
));
const validate = new Ajv2020({ allErrors: true }).compile(schema);

const input = {
  requestItemId: "fixture_item_00000001",
  jobProjection: {
    hard_requirements: { required_skills: ["JavaScript", "SQL"], locations: ["上海"], min_experience_years: 5, salary: { minimum: 25, maximum: 40 } },
    scoring_context: { industry: "软件", seniority: "高级" },
  },
  candidateProjection: {
    profile: { skills: ["JavaScript", "TypeScript", "SQL"], city: "上海", experience_years: 8, industry: "软件", seniority: "高级", expected_salary: { minimum: 30, maximum: 38 }, activity_updated_at: "2026-08-01" },
    redactedDetail: { career_history: [{ role: "高级工程师", industry: "软件", duration_months: 48 }] },
  },
};

test("Fake LLM：固定输入产生固定且符合七维 Schema 的结构化输出", async () => {
  const adapter = createFakeDetailScoringAdapter();
  const first = await adapter.score(input);
  const second = await adapter.score(input);
  assert.deepEqual(first, second);
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  assert.deepEqual(first.dimensions.map((item) => item.dimension), [
    "skills", "industry", "seniority", "experience", "location", "salary", "activity",
  ]);
  assert.equal("total_score" in first, false);
});

test("Fake LLM：证据不足的维度不猜分", async () => {
  const output = await createFakeDetailScoringAdapter().score({
    ...input,
    candidateProjection: { profile: {}, redactedDetail: {} },
  });
  const activity = output.dimensions.find((item) => item.dimension === "activity");
  assert.deepEqual(activity, {
    dimension: "activity", assessable: false, score: null, evidence: [], confidence: 0,
  });
});
