import assert from "node:assert/strict";
import test from "node:test";

import { JOB_CATEGORY_BUCKETS, mapJobCategory } from "../lib/job-category.mjs";

test("分类桶为 4 粗桶 + 其他", () => {
  assert.deepEqual(JOB_CATEGORY_BUCKETS, [
    "技术研发",
    "产品设计",
    "市场销售",
    "数据智能",
    "其他",
  ]);
});

test("技术研发类职位映射", () => {
  for (const category of [
    "JAVA",
    "Web 前端",
    "C / C++",
    "架构师",
    "硬件工程师",
    "技术 VP / CTO",
    "售前工程师",
  ]) {
    assert.equal(mapJobCategory(category), "技术研发", category);
  }
});

test("产品设计类职位映射", () => {
  for (const category of [
    "AI 产品经理",
    "电商产品经理",
    "视觉设计师",
    "产品运营",
    "用户研究经理",
    "广告创意",
  ]) {
    assert.equal(mapJobCategory(category), "产品设计", category);
  }
});

test("市场销售类职位映射", () => {
  for (const category of [
    "市场总监",
    "销售总监",
    "运营总监",
    "大客户代表",
    "新媒体运营",
    "渠道推广",
    "内容运营",
  ]) {
    assert.equal(mapJobCategory(category), "市场销售", category);
  }
});

test("数据智能类职位映射", () => {
  for (const category of [
    "数据分析 / 挖掘",
    "数据开发",
    "深度学习",
    "算法工程师",
    "推荐算法",
    "数据科学家 / 专家",
    "机器学习",
    "自然语言处理 NLP",
    "数据建模 / 仓库 / BI 工程师",
  ]) {
    assert.equal(mapJobCategory(category), "数据智能", category);
  }
});

test("其他类职位映射", () => {
  for (const category of [
    "CEO / 总裁 / 总经理",
    "人力资源总监",
    "法务经理 / 主管",
    "证券交易员",
    "行业研究",
    "其他",
  ]) {
    assert.equal(mapJobCategory(category), "其他", category);
  }
});

test("空值 / null / 未映射类别一律归其他", () => {
  assert.equal(mapJobCategory(""), "其他");
  assert.equal(mapJobCategory(null), "其他");
  assert.equal(mapJobCategory("不存在的类别"), "其他");
});
