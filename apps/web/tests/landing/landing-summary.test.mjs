import assert from "node:assert/strict";
import test from "node:test";

import { inferJobSummary } from "../../lib/landing/landing-summary.mjs";

test("白名单变量抽取：只含词库能力词/部门词/动作词，公司/产品专名永不进入", () => {
  const summary = inferJobSummary({
    category: "",
    title: "算法工程师",
    jobDescription:
      "我们（Lovart 平台）专注 AI Agent 智能体编排，负责大模型推理与 RAG 检索的研发，覆盖电商场景。",
  });
  assert.ok(summary.includes("AI Agent"), "命中白名单能力词");
  assert.ok(summary.includes("大模型"), "命中白名单能力词");
  assert.ok(!summary.includes("Lovart"), "结构性保证：公司/产品专名绝不进入");
  assert.ok(!summary.includes("平台专注"), "不包含 JD 原文片段");
});

test("真实样例（媒介负责人 JD）：团队/能力/动作/协同团队全部作变量从 JD 抽取", () => {
  const jd = [
    "岗位背景】 Lovart 致力于通过前沿的 AI 技术重塑创意工作流。作为 Lovart 的媒介负责人，你将是连接产品与大众的核心桥梁，负责构建并主导我们的媒介传播矩阵。",
    "媒介战略规划： 基于 Lovart 的产品迭代节奏与品牌定位，制定全周期的媒介传播策略，统筹线上线下媒介资源的组合与投放。",
    "内容传播统筹： 协同内容、产品及公关团队，挖掘 Lovart 的技术亮点与用户故事，策划具有行业影响力的话题与爆款传播事件。",
    "投放与效果评估： 建立科学的媒介投放模型，管理媒介预算，实时监控传播数据，通过多维度的数据复盘，持续优化投放策略。",
    "舆情与危机管理： 建立完善的日常舆情监测机制，制定并执行有效的危机公关预案，维护 Lovart 良好的品牌声誉。",
  ].join("\n");

  const summary = inferJobSummary({ category: "", title: "媒介负责人", jobDescription: jd });
  // 团队：媒介（出现在 JD，且不在协同上下文）
  assert.ok(summary.includes("媒介团队"), "团队变量来自 JD（媒介）");
  // 协作团队：产品/内容（出现在「协同…」上下文）
  assert.ok(summary.includes("产品"), "协同团队变量来自 JD");
  assert.ok(summary.includes("内容"), "协同团队变量来自 JD");
  // 能力词
  assert.ok(
    summary.includes("媒体关系") || summary.includes("内容传播") || summary.includes("增长"),
    "能力词变量来自 JD",
  );
  // 动作词
  assert.ok(summary.includes("规划") || summary.includes("统筹"), "动作词变量来自 JD");
  // 结构性安全
  assert.ok(!summary.includes("Lovart"));
});

test("协作团队仅在协同上下文抽取：独立出现的产品词归团队而非协作", () => {
  const jd = "负责产品需求梳理与文档撰写，独立推进版本迭代，与运营团队配合完成上线。";
  const summary = inferJobSummary({ category: "", title: "产品经理", jobDescription: jd });
  assert.ok(summary.includes("产品团队"), "独立产品词归团队变量");
  assert.ok(summary.includes("运营"), "协同上下文附近的产品/运营词归协作团队");
});

test("技术研发桶：无部门词时回退研发团队", () => {
  const summary = inferJobSummary({
    category: "",
    title: "Web 前端工程师",
    jobDescription: "负责前端工程化与组件库建设，覆盖电商场景。",
  });
  assert.ok(summary.includes("研发团队"), "技术研发桶团队回退");
  assert.ok(summary.includes("前端工程化"), "能力词变量");
  assert.ok(summary.includes("组件库"), "能力词变量");
});

test("无 JD / 无白名单命中：回退安全通用文案，不崩溃、不泄漏", () => {
  const empty = inferJobSummary({ category: "", title: "媒介负责人", jobDescription: null });
  assert.ok(!empty.includes("null"), "null JD 不产出字面量 null");
  assert.ok(empty.includes("团队"), "回退仍有团队占位");

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

test("变量截断：协同团队前 2、能力词前 3、动作词前 2", () => {
  const jd = [
    "与产品、运营、设计团队协同推进。",
    "负责大模型、机器学习、深度学习、强化学习相关工作，参与规划、拓展、复盘与优化。",
  ].join(" ");
  const tech = inferJobSummary({ category: "", title: "算法工程师", jobDescription: jd });
  assert.ok(tech.includes("与产品、运营团队"), "协同团队取前 2 个（产品、运营）");
  assert.ok(tech.includes("大模型") && tech.includes("机器学习") && tech.includes("深度学习"));
  assert.ok(!tech.includes("强化学习"), "能力词最多 3 个");

  const market = inferJobSummary({ category: "", title: "市场专员", jobDescription: jd });
  assert.ok(!market.includes("复盘"), "动作词最多 2 个");
});
