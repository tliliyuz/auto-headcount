import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  computeInputHash,
  dimensionScores,
  hardFilter,
  scoreMatch,
} from "../../lib/matching/score.mjs";

function jobRequirements(overrides = {}) {
  return {
    skills: ["Node.js", "PostgreSQL"],
    seniority: "高级",
    education: "本科",
    salaryMin: 30,
    salaryMax: 60,
    location: "上海",
    industry: "互联网",
    min_experience_years: 5,
    ...overrides,
  };
}

function candidateProfile(overrides = {}) {
  return {
    skills: ["Node.js", "PostgreSQL", "React"],
    experienceYears: 7,
    location: "上海",
    education: "硕士",
    seniority: "高级",
    industry: "互联网",
    expectedSalaryMin: 35,
    expectedSalaryMax: 55,
    activityUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("hardFilter：技能/年限/学历/地点硬过滤", () => {
  // 全部满足
  assert.deepEqual(hardFilter({ jobRequirements: jobRequirements(), candidateProfile: candidateProfile() }), {
    passed: true,
    missing: [],
  });
  // 缺关键技能 → 不过
  const noSkill = hardFilter({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["React", "Java"] }),
  });
  assert.equal(noSkill.passed, false);
  assert.ok(noSkill.missing[0].includes("缺少关键技能"));
  // 年限不足 → 不过
  const noYears = hardFilter({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ experienceYears: 2 }),
  });
  assert.equal(noYears.passed, false);
  // 学历不足 → 不过
  const lowEdu = hardFilter({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ education: "大专" }),
  });
  assert.equal(lowEdu.passed, false);
});

test("scoreMatch：加权总分可复算 + 分带边界（85/75）+ 输入哈希稳定", () => {
  const input = {
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile(),
    ruleVersion: 1,
  };
  const first = scoreMatch(input);
  const second = scoreMatch(input);
  assert.equal(first.passed, true);
  assert.equal(first.totalScore, second.totalScore, "同输入同规则可复算");
  assert.equal(first.inputHash, second.inputHash, "输入哈希稳定");
  assert.equal(first.inputHash, computeInputHash(input), "哈希与 computeInputHash 一致");

  // 分带边界
  const high = scoreMatch({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: jobRequirements().skills }),
    ruleVersion: 1,
  });
  assert.ok(high.totalScore >= 85, "满分候选人应高匹配");
  assert.equal(high.band, "high");
  assert.equal(DEFAULT_THRESHOLDS.high, 85);
  assert.equal(DEFAULT_THRESHOLDS.medium, 75);

  // 权重和 = 1
  const totalWeight = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9, "权重和应为 1");

  // 硬过滤不过 → passed:false, 无总分
  const failed = scoreMatch({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["Java"] }),
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.totalScore, null);
});

test("dimensionScores：7 维 + 缺失数据中性分 + 证据/风险", () => {
  const dims = dimensionScores({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile(),
  });
  assert.equal(dims.length, 7);
  const names = dims.map((d) => d.dimension);
  assert.deepEqual(names, ["技能", "行业", "职级", "经历", "地点", "薪资", "活跃度"]);
  const skill = dims.find((d) => d.dimension === "技能");
  assert.equal(skill.score, 100, "技能全覆盖 100");
  const location = dims.find((d) => d.dimension === "地点");
  assert.equal(location.score, 100, "同城 100");

  // 缺失数据 → 中性 50 + 风险提示
  const sparse = dimensionScores({
    jobRequirements: jobRequirements(),
    candidateProfile: { skills: [] },
  });
  for (const d of sparse) {
    assert.ok(d.score >= 0 && d.score <= 100);
  }
});

test("computeInputHash：字段顺序无关但内容相关", () => {
  const a = computeInputHash({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["Node.js", "PostgreSQL", "React"] }),
    ruleVersion: 1,
  });
  const b = computeInputHash({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["React", "Node.js", "PostgreSQL"] }),
    ruleVersion: 1,
  });
  assert.equal(a, b, "技能顺序无关（归一化排序）");
  const c = computeInputHash({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["Node.js"] }),
    ruleVersion: 1,
  });
  assert.notEqual(a, c, "内容不同哈希不同");
  const d = computeInputHash({
    jobRequirements: jobRequirements(),
    candidateProfile: candidateProfile({ skills: ["Node.js", "PostgreSQL", "React"] }),
    ruleVersion: 2,
  });
  assert.notEqual(a, d, "规则版本不同哈希不同");
});
