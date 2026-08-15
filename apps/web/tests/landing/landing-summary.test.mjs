import assert from "node:assert/strict";
import test from "node:test";

import { inferJobSummary } from "../../lib/landing/landing-summary.mjs";

test("白名单变量抽取：只含词库能力词/行业词，公司名/产品专名永不进入", () => {
  const summary = inferJobSummary({
    category: "",
    title: "算法工程师",
    jobDescription:
      "我们（Lovart 平台）专注 AI Agent 智能体编排，负责大模型推理与 RAG 检索的研发，覆盖电商场景。",
  });
  assert.ok(summary.includes("AI Agent"), "命中白名单能力词");
  assert.ok(summary.includes("大模型"), "命中白名单能力词");
  assert.ok(summary.includes("电商"), "命中白名单行业词");
  assert.ok(!summary.includes("Lovart"), "结构性保证：公司/产品专名绝不进入");
  assert.ok(!summary.includes("平台专注"), "不包含 JD 原文片段");
});

test("大类桶模板：算法标题归数据智能", () => {
  const summary = inferJobSummary({
    category: "",
    title: "搜索算法工程师",
    jobDescription: "负责推荐系统与深度学习模型的优化。",
  });
  assert.ok(summary.includes("数据/算法团队"), "数据智能桶模板");
  assert.ok(summary.includes("推荐系统"), "能力词变量");
  assert.ok(summary.includes("深度学习"), "能力词变量");
});

test("技术研发桶：前端/后端标题归技术研发", () => {
  const summary = inferJobSummary({
    category: "",
    title: "Web 前端工程师",
    jobDescription: "负责前端工程化与组件库建设，覆盖电商场景。",
  });
  assert.ok(summary.includes("研发团队"), "技术研发桶模板");
  assert.ok(summary.includes("前端工程化"));
  assert.ok(summary.includes("组件库"));
});

test("无 JD / 无白名单命中：回退安全通用文案，不崩溃、不泄漏", () => {
  const empty = inferJobSummary({ category: "", title: "媒介负责人", jobDescription: null });
  assert.ok(!empty.includes("null"), "null JD 不产出字面量 null");
  assert.ok(empty.includes("相关") && empty.includes("核心业务"), "回退占位");

  const brandOnly = inferJobSummary({
    category: "",
    title: "运营",
    jobDescription: "Lovart 致力于通过前沿 AI 重塑创意工作流，为全球创作者提供服务。",
  });
  assert.ok(!brandOnly.includes("Lovart"), "纯品牌文案不泄漏");
  assert.ok(brandOnly.includes("核心业务"), "无白名单命中回退");
});

test("确定性：同输入同输出", () => {
  const input = { category: "数据智能", title: "算法工程师", jobDescription: "负责大模型训练与多模态。" };
  assert.equal(inferJobSummary(input), inferJobSummary(input));
});

test("白名单截断：能力词取前 3、行业词取前 2", () => {
  const summary = inferJobSummary({
    category: "",
    title: "工程师",
    jobDescription: "涉及大模型、机器学习、深度学习、强化学习、电商、金融、教育。",
  });
  assert.ok(summary.includes("大模型"));
  assert.ok(summary.includes("机器学习"));
  assert.ok(summary.includes("深度学习"));
  assert.ok(!summary.includes("强化学习"), "能力词最多 3 个");
  assert.ok(summary.includes("电商") && summary.includes("金融"));
  assert.ok(!summary.includes("教育"), "行业词最多 2 个");
});
