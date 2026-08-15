import assert from "node:assert/strict";
import test from "node:test";

import { toMaskedJobView } from "../../lib/landing/landing-mask.mjs";

const LONG_JD = "【岗位背景】 Lovart 致力于通过 AI 重塑创意工作流。".repeat(40);

test("脱敏白名单：标题/类别/城市/薪资范围/去标识化摘要，剔除公司名/地址/原始 JD", () => {
  const view = toMaskedJobView({
    title: "高级前端工程师",
    category: "Engineering",
    city: "上海",
    salaryMin: 20,
    salaryMax: 30,
    jobDescription: LONG_JD,
    companyName: "某大厂",
    companyAlias: "大厂A",
    detailedLocation: "上海市浦东新区张江路 1 号",
    externalId: "JOB-999",
    portalUrl: "https://portal.invalid/jobs/999",
  });
  assert.deepEqual(
    Object.keys(view).sort(),
    ["category", "city", "salaryRange", "summary", "title"],
  );
  assert.equal(view.title, "高级前端工程师");
  assert.equal(view.salaryRange, "20–30");
  assert.ok(view.summary.includes("研发团队"), "摘要由白名单模板生成");
  assert.ok(!view.summary.includes("Lovart"), "摘要不含 JD 内嵌品牌名");

  const json = JSON.stringify(view);
  assert.ok(!json.includes("某大厂"), "不包含公司名");
  assert.ok(!json.includes("大厂A"), "不包含公司别名");
  assert.ok(!json.includes("浦东"), "不包含详细地址");
  assert.ok(!json.includes("JOB-999"), "不包含内部职位编号");
  assert.ok(!json.includes("portal"), "不包含门户链接");
  assert.ok(!json.includes("岗位背景"), "不包含原始 JD 文本");
});

test("薪资边界缺失 → 安全降级文案，不推断精确值", () => {
  const base = { title: "x", category: "x", city: "x", jobDescription: null };
  assert.equal(toMaskedJobView({ ...base, salaryMin: null, salaryMax: null }).salaryRange, "薪资面议");
  assert.equal(toMaskedJobView({ ...base, salaryMin: 20, salaryMax: null }).salaryRange, "薪资面议");
  assert.equal(toMaskedJobView({ ...base, salaryMin: null, salaryMax: 30 }).salaryRange, "薪资面议");
  assert.equal(toMaskedJobView({ ...base, salaryMin: 20, salaryMax: 10 }).salaryRange, "薪资面议");
});

test("职责摘要为白名单生成：原始 JD 内嵌品牌名绝不进入 DTO", () => {
  const view = toMaskedJobView({
    title: "x",
    category: "x",
    city: "x",
    salaryMin: 20,
    salaryMax: 30,
    jobDescription: "【岗位背景】 Lovart 致力于通过前沿的 AI 技术重塑创意工作流，为全球创作者提供服务。",
  });
  assert.ok("summary" in view, "DTO 含白名单生成的摘要");
  assert.ok(!JSON.stringify(view).includes("Lovart"), "摘要不含品牌名");
  assert.ok(!JSON.stringify(view).includes("【岗位背景】"), "不含原始 JD 文本");
});
