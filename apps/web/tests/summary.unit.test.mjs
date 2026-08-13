import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCandidate, summarizeJob } from "../lib/summaries/summary.mjs";

test("summarizeJob：≤150 字且不含联系方式/直接身份标识", () => {
  const s = summarizeJob({
    title: "资深前端工程师",
    category: "技术研发",
    city: "上海",
    salaryMin: 40,
    salaryMax: 60,
  });
  assert.ok(s.length <= 150, "≤150 字");
  assert.ok(s.includes("资深前端工程师"));
  assert.ok(s.includes("上海"));
  assert.ok(!/1[3-9]\d{9}/.test(s), "无手机号");
  assert.ok(!/@/.test(s), "无邮箱");
  assert.ok(!/138\d{8}/.test(s), "无联系方式");

  // 超长标题截断
  const long = summarizeJob({ title: "长".repeat(200), category: "A", city: "B" });
  assert.ok(long.length <= 150);
  assert.ok(long.endsWith("…"));
});

test("summarizeCandidate：打码名 + 现职，无联系方式/身份标识", () => {
  const s = summarizeCandidate({
    displayName: "张**",
    currentTitle: "算法工程师",
    currentCompany: "示例公司",
    city: "上海",
    experienceYears: 6,
  });
  assert.ok(s.length <= 150);
  assert.ok(s.includes("张**"));
  assert.ok(s.includes("算法工程师"));
  assert.ok(s.includes("6 年经验"));
  assert.ok(!/\d{11}/.test(s), "无手机号");
  assert.ok(!/@/.test(s), "无邮箱");

  // 缺失字段不崩
  assert.equal(summarizeCandidate(null), "");
  assert.equal(summarizeJob(null), "");
});
