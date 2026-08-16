import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJobRequirements,
  extractEducation,
  extractSalary,
  extractSkills,
} from "../lib/jobs/job-requirements-extract.mjs";

/** 提取器是确定性纯函数：同输入 → 同输出；输出只可能来自白名单词库（结构去标识化）。 */

test("skills：JD 中的技术词按白名单命中，输出有序", () => {
  const out = extractJobRequirements({
    title: "后端开发工程师",
    category: "技术研发",
    jobDescription: "精通 Java、Spring、MySQL，熟悉分布式/高并发",
  });
  for (const skill of ["Java", "Spring", "MySQL", "分布式", "高并发"]) {
    assert.ok(out.skills.includes(skill), `应命中 ${skill}`);
  }
  assert.ok(out.skills.length >= 5);
  // 有序（与 normalizeJobInput 的排序口径一致）
  assert.deepEqual(out.skills, [...out.skills].sort());
});

test("skills：确定性（同输入两次结果深度相等）", () => {
  const input = {
    title: "算法工程师",
    category: "数据智能",
    jobDescription: "精通机器学习与深度学习，熟悉大模型推理与推荐算法",
  };
  const first = extractJobRequirements(input);
  const second = extractJobRequirements(input);
  assert.deepEqual(second, first);
});

test("skills：空/缺失 JD 不崩溃，skills 为空", () => {
  const out = extractJobRequirements({ title: "职位", category: "技术", jobDescription: "" });
  assert.deepEqual(out.skills, []);
  assert.equal(out.seniority, null);
  assert.equal(out.education, null);
  assert.equal(out.salaryMin, null);
  assert.equal(out.salaryMax, null);
  assert.ok(out.extraction_warnings.includes("JD 为空，未提取任何结构化要求"));
});

test("education：硬性学历门槛取最高档", () => {
  assert.equal(extractEducation("统招本科及以上学历").value, "本科");
  // 本科硬性、硕士仅优先 → 取本科
  const out = extractJobRequirements({
    title: "工程师",
    category: "技术",
    jobDescription: "统招本科及以上学历，硕士优先",
  });
  assert.equal(out.education, "本科");
});

test("education：仅「优先」形式出现不算硬性门槛", () => {
  const result = extractEducation("硕士优先");
  assert.equal(result.value, null);
  assert.ok(result.warning);
  const out = extractJobRequirements({
    title: "工程师",
    category: "技术",
    jobDescription: "硕士优先",
  });
  assert.equal(out.education, null);
  assert.ok(out.extraction_warnings.some((w) => w.includes("优先")));
});

test("education：同义词研究生→硕士", () => {
  assert.equal(extractEducation("研究生学历").value, "硕士");
});

test("seniority：title 优先、JD 紧邻角色名词才算，取最高档", () => {
  const fromTitle = extractJobRequirements({ title: "高级后端工程师", category: "技术", jobDescription: "" });
  assert.equal(fromTitle.seniority, "高级");
  const fromJd = extractJobRequirements({
    title: "后端工程师",
    category: "技术",
    jobDescription: "我们正在招聘资深产品经理，负责平台产品",
  });
  assert.equal(fromJd.seniority, "资深");
  const none = extractJobRequirements({ title: "工程师", category: "技术", jobDescription: "负责平台功能开发" });
  assert.equal(none.seniority, null);
});

test("experience：N年以上 / N-M年 / N~M年 → min；N年以下 → null + warning", () => {
  const a = extractJobRequirements({ title: "工程师", category: "技术", jobDescription: "需要3年以上相关经验" });
  assert.equal(a.constraints.min_experience_years, 3);
  const b = extractJobRequirements({ title: "工程师", category: "技术", jobDescription: "5-8年经验" });
  assert.equal(b.constraints.min_experience_years, 5);
  const c = extractJobRequirements({ title: "工程师", category: "技术", jobDescription: "3~5年经验" });
  assert.equal(c.constraints.min_experience_years, 3);
  const d = extractJobRequirements({ title: "工程师", category: "技术", jobDescription: "2年以下经验" });
  assert.equal(d.constraints.min_experience_years, null);
  assert.ok(d.extraction_warnings.some((w) => w.includes("年")));
});

test("salary：显式月薪 k/万 解析；年薪/面议/超界 不推断", () => {
  assert.deepEqual(extractSalary("薪资20K-35K"), { min: 20000, max: 35000, warning: null });
  assert.deepEqual(extractSalary("20-35K·14薪"), { min: 20000, max: 35000, warning: null });
  assert.deepEqual(extractSalary("2-3.5万/月"), { min: 20000, max: 35000, warning: null });
  const annual = extractSalary("年薪30-50万");
  assert.equal(annual.min, null);
  assert.equal(annual.max, null);
  assert.ok(annual.warning);
  const negotiable = extractSalary("薪资面议");
  assert.equal(negotiable.min, null);
  assert.ok(negotiable.warning);
  const tooBig = extractSalary("800K-1200K");
  assert.equal(tooBig.max, null);
  assert.ok(tooBig.warning);
});

test("constraints：证书白名单 / preferred_skills 仅限优先语境 / 固定形状", () => {
  const out = extractJobRequirements({
    title: "项目经理",
    category: "产品设计",
    jobDescription: "需持有PMP证书；有分布式经验者优先",
  });
  assert.deepEqual(out.constraints.required_certificates, ["PMP"]);
  assert.deepEqual(out.constraints.preferred_skills, ["分布式"]);
  assert.equal(out.constraints.business_context, null);
  assert.equal(out.constraints.salary_hard_constraint, true);
});

test("skills：分字段助手按词库顺序取前 limit 个", () => {
  const hits = extractSkills("熟悉Java、MySQL、Redis、Kafka、Docker、Elasticsearch、Flink、Spark、机器学习", 10);
  assert.ok(hits.includes("Java"));
  assert.ok(hits.includes("Elasticsearch"));
  assert.ok(hits.length <= 10);
});

test("结构保证：JD 含品牌/专名时输出绝不包含它", () => {
  const out = extractJobRequirements({
    title: "后端工程师",
    category: "技术研发",
    jobDescription:
      "字节跳动旗下抖音团队招聘高级后端工程师，精通 Java、Spring、MySQL，负责推荐系统建设，薪资30K-50K",
  });
  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("字节跳动"), "不得泄漏公司名");
  assert.ok(!serialized.includes("抖音"), "不得泄漏产品名");
  assert.equal(out.seniority, "高级");
  assert.ok(out.skills.includes("Java"));
});
