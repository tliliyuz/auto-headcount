import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_CATEGORY_BUCKETS,
  inferCoarseBucketFromTitle,
  jobCoarseBucket,
  mapJobCategory,
} from "../lib/job-category.mjs";

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

test("标题推断：真实沉睡职位标题归桶", () => {
  const cases = [
    // 与当前 dev 库 40 条沉睡职位标题同源
    ["AI Agent智能体开发工程师(LangGraph/编排)", "技术研发"],
    ["知识图谱/Text2SQL数据智能工程师", "数据智能"],
    ["AI应用创业者/技术合伙人(0→1产品)", "技术研发"],
    ["资深产品经理（财务方向）", "产品设计"],
    ["媒介负责人", "市场销售"],
    ["架构组负责人（系统架构师）", "技术研发"],
    ["小红书-HRBP（产研方向）-北京上海", "其他"],
    ["技术专家/资深研发工程师-核身", "技术研发"],
    ["供应链算法资深经理/专家", "数据智能"],
    ["商业分析专家/资深商业分析（经营分析）", "数据智能"],
    ["资深产品经理（供应链）", "产品设计"],
  ];
  for (const [title, bucket] of cases) {
    assert.equal(inferCoarseBucketFromTitle(title), bucket, title);
  }
});

test("标题推断：强角色词覆盖领域词", () => {
  // 「产品经理」是角色，「财务/供应链/搜索」只是领域，不能被领域词带偏
  assert.equal(inferCoarseBucketFromTitle("数据产品经理"), "产品设计");
  assert.equal(inferCoarseBucketFromTitle("AI 产品经理"), "产品设计");
  // HRBP 是角色，「产研」只是领域，不能归技术研发
  assert.equal(inferCoarseBucketFromTitle("HRBP（产研方向）"), "其他");
  // 视觉设计师是设计岗，机器视觉工程师是数据岗，同词不同桶
  assert.equal(inferCoarseBucketFromTitle("视觉设计师"), "产品设计");
  assert.equal(inferCoarseBucketFromTitle("机器视觉工程师"), "数据智能");
});

test("标题推断：空值 / 无关键词归其他", () => {
  assert.equal(inferCoarseBucketFromTitle(""), "其他");
  assert.equal(inferCoarseBucketFromTitle(null), "其他");
  assert.equal(inferCoarseBucketFromTitle("行政前台"), "其他");
});

test("jobCoarseBucket：源 category 优先，空时回退标题推断", () => {
  assert.equal(jobCoarseBucket("深度学习", ""), "数据智能");
  assert.equal(jobCoarseBucket("", "JAVA 开发工程师"), "技术研发");
  assert.equal(jobCoarseBucket("", "资深产品经理"), "产品设计");
  assert.equal(jobCoarseBucket("", ""), "其他");
  assert.equal(jobCoarseBucket(null, "数据科学家"), "数据智能");
  assert.equal(jobCoarseBucket("算法工程师", "开发工程师"), "数据智能");
});
