import assert from "node:assert/strict";
import test from "node:test";

import { buildRedactedCareerHistory } from "../../lib/jobs/candidate-redaction-loader.mjs";
import { scanResidualPii } from "../../lib/matching/candidate-projection.mjs";

test("buildRedactedCareerHistory：公司名完全泛化为「某公司」，真实公司名不进入文本", () => {
  const out = buildRedactedCareerHistory([{ company: "字节跳动", title: "资深开发" }]);
  assert.deepEqual(out, ["某公司 · 资深开发"]);
  assert.ok(!out[0].includes("字节跳动"), "真实公司名不得进入 career_history");
});

test("buildRedactedCareerHistory：空 title 条目跳过，去重 + 排序稳定", () => {
  const out = buildRedactedCareerHistory([
    { company: "A", title: "高级工程师" },
    { company: "B", title: "   " },
    { company: "C", title: "高级工程师" },
    { company: "D", title: "资深开发" },
  ]);
  assert.deepEqual(out, ["某公司 · 资深开发", "某公司 · 高级工程师"]);
});

test("buildRedactedCareerHistory：maxItems 默认 30 条截断", () => {
  const input = Array.from({ length: 35 }, (_, i) => ({
    company: "某公司",
    title: `职位${i}`,
  }));
  const out = buildRedactedCareerHistory(input);
  assert.equal(out.length, 30);
});

test("buildRedactedCareerHistory：逐条超 1000 字符丢弃", () => {
  const out = buildRedactedCareerHistory([
    { company: "某公司", title: "X".repeat(1000) },
    { company: "某公司", title: "高级工程师" },
  ]);
  assert.deepEqual(out, ["某公司 · 高级工程师"]);
});

test("buildRedactedCareerHistory：非数组 / 空输入 → []", () => {
  assert.deepEqual(buildRedactedCareerHistory(undefined), []);
  assert.deepEqual(buildRedactedCareerHistory(null), []);
  assert.deepEqual(buildRedactedCareerHistory([]), []);
  assert.deepEqual(buildRedactedCareerHistory([{ company: "某公司", title: null }]), []);
});

test("PII 交互：城市名/常见 title 不误触发 detailed_address；真实街道级地址仍触发", () => {
  // 城市名带「市」后缀、title 含「市场」「区域」等 → 不得误判为详细地址（2026-08-16 修正 `*`→`+`）
  for (const career_history of [
    ["某公司 · 高级工程师"],
    ["某公司 · 区域经理"],
    ["某公司 · 品牌市场专家"],
    ["某公司 · 智慧城市研发总监"],
  ]) {
    const scan = scanResidualPii({
      profile: { location: "北京市" },
      redactedDetail: { career_history, project_highlights: [] },
    });
    assert.deepEqual(scan.detected, [], `不应误触发 detailed_address：${career_history[0]}`);
  }

  // 真实街道/楼栋级地址（关键字后跟数字/字母）仍应触发并 fail-closed
  const addr = scanResidualPii({
    profile: {},
    redactedDetail: { career_history: ["解放路5号"], project_highlights: [] },
  });
  assert.ok(addr.detected.includes("detailed_address"), "真实详细地址应触发 detailed_address");
});
