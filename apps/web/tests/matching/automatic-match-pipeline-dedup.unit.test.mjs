import assert from "node:assert/strict";
import test from "node:test";

import { preRank, withMergedLocations } from "../../lib/jobs/automatic-match-pipeline.mjs";

test("preRank：groupCities 给跨城市候选人 cityHit=1", () => {
  const job = { hard_requirements: { required_skills: ["Node.js"], locations: ["上海"] } };
  const candidate = { skills: ["Node.js"], city: "广州" };
  // 当前 preRank 用 job.locations=["上海"] → cityHit=0；groupCities=["广州","上海"] → cityHit=1
  assert.equal(preRank(job, candidate, ["广州", "上海"]), 11);
});

test("preRank：无 groupCities 时回退 job.locations（保持原行为）", () => {
  const job = { hard_requirements: { required_skills: ["Node.js"], locations: ["上海"] } };
  const candidate = { skills: ["Node.js"], city: "广州" };
  assert.equal(preRank(job, candidate, undefined), 10, "跨城市但无并集 → cityHit=0");
  assert.equal(preRank(job, { skills: ["Node.js"], city: "上海" }, undefined), 11, "同城 → cityHit=1");
});

test("withMergedLocations：覆盖 locations（克隆不原地改）", () => {
  const jr = { hard_requirements: { locations: ["上海"] }, scoring_context: {} };
  const merged = withMergedLocations(jr, ["广州", "上海"]);
  assert.deepEqual(merged.hard_requirements.locations, ["广州", "上海"]);
  assert.notEqual(merged, jr, "应克隆，不原地修改");
  assert.equal(merged.scoring_context, jr.scoring_context, "浅克隆保留其他字段引用");
});

test("withMergedLocations：空/undefined groupCities 不覆盖，返回原对象", () => {
  const jr = { hard_requirements: { locations: ["上海"] } };
  assert.equal(withMergedLocations(jr, []), jr);
  assert.equal(withMergedLocations(jr, undefined), jr);
  assert.equal(withMergedLocations(jr, null), jr);
});
