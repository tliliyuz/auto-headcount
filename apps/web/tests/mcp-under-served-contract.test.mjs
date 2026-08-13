import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseJobsListResult,
  parseMatchCandidatesResult,
  parseUnderServedJobsResult,
  selectEligibleUnderServedJobs,
  selectEligibleUnderServedPairs,
} from "../lib/adapters/mcp-under-served-contract.mjs";

const fixtureUrl = new URL(
  "../fixtures/mcp/under-served-response-2026-08-11.json",
  import.meta.url,
);

const jobsListFixtureUrl = new URL(
  "../fixtures/mcp/wb-jobs-list-response-2026-08-13.json",
  import.meta.url,
);

const matchCandidatesFixtureUrl = new URL(
  "../fixtures/mcp/match-candidates-response-2026-08-12.json",
  import.meta.url,
);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

async function loadJobsListFixture() {
  return JSON.parse(await readFile(jobsListFixtureUrl, "utf8"));
}

async function loadMatchCandidatesFixture() {
  return JSON.parse(await readFile(matchCandidatesFixtureUrl, "utf8"));
}

test("解析真实响应形状并保留供应商筛选证据", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());

  assert.equal(page.total, 1);
  assert.equal(page.jobs[0].externalId, "fixture-job-001");
  assert.equal(page.jobs[0].ageDays, 7);
  assert.equal(page.jobs[0].sourceCreatedAt, null);
  assert.deepEqual(page.jobs[0].eligibilityEvidence, {
    activeStatus: "provider_filter",
    zeroRecommendations: "provider_filter",
    age: "days_without_rec",
  });
});

test("本地业务规则包含 7 和 30，排除 31 天", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());
  const base = page.jobs[0];

  assert.deepEqual(
    selectEligibleUnderServedJobs({
      ...page,
      jobs: [
        { ...base, externalId: "day-7", ageDays: 7 },
        { ...base, externalId: "day-30", ageDays: 30 },
        { ...base, externalId: "day-31", ageDays: 31 },
      ],
    }).map((job) => job.externalId),
    ["day-7", "day-30"],
  );
});

test("字段类型漂移时明确失败，不把无效响应写入业务模型", async () => {
  const fixture = await loadFixture();
  const payload = JSON.parse(fixture.content[0].text);
  payload.Data.list[0].days_without_rec = "7";
  fixture.content[0].text = JSON.stringify(payload);

  assert.throws(
    () => parseUnderServedJobsResult(fixture),
    (error) => {
      assert.equal(error.code, "MCP_CONTRACT_INVALID");
      assert.match(error.message, /days_without_rec/);
      return true;
    },
  );
});

test("解析结果保留原始上游列表项并按索引与规范化职位对齐", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());

  assert.ok(Array.isArray(page.rawItems));
  assert.equal(page.rawItems.length, page.jobs.length);
  assert.equal(page.rawItems[0].job_id, page.jobs[0].externalId);
  assert.equal(page.rawItems[0].job_id, "fixture-job-001");
});

test("配对函数按索引返回合格职位与原始载荷，剔除 31 天", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());
  const base = page.jobs[0];
  const synthetic = {
    ...page,
    jobs: [
      { ...base, externalId: "day-7", ageDays: 7 },
      { ...base, externalId: "day-30", ageDays: 30 },
      { ...base, externalId: "day-31", ageDays: 31 },
    ],
    rawItems: [
      { job_id: "day-7", marker: "m1" },
      { job_id: "day-30", marker: "m2" },
      { job_id: "day-31", marker: "m3" },
    ],
  };

  const pairs = selectEligibleUnderServedPairs(synthetic);
  assert.deepEqual(
    pairs.map((pair) => pair.job.externalId),
    ["day-7", "day-30"],
  );
  assert.deepEqual(
    pairs.map((pair) => pair.rawItem.job_id),
    ["day-7", "day-30"],
  );
  assert.deepEqual(
    pairs.map((pair) => pair.index),
    [0, 1],
  );
});

test("jobs 与 rawItems 长度不一致时明确失败", async () => {
  const page = parseUnderServedJobsResult(await loadFixture());
  const broken = { ...page, rawItems: [page.rawItems[0], page.rawItems[0]] };

  assert.throws(
    () => selectEligibleUnderServedPairs(broken),
    (error) => error.code === "MCP_CONTRACT_INVALID",
  );
});

test("公司/城市/类别为空（null 或空串）不再拒绝整页解析，归一为空串入库", async () => {
  const fixture = await loadFixture();
  const payload = JSON.parse(fixture.content[0].text);
  payload.Data.list[0].client_company = null;
  payload.Data.list[0].city = "";
  payload.Data.list[0].category = "";
  fixture.content[0].text = JSON.stringify(payload);

  const page = parseUnderServedJobsResult(fixture);
  assert.equal(page.jobs[0].companyName, "", "null 公司归一为空串");
  assert.equal(page.jobs[0].city, "", "空串城市原样保留");
  assert.equal(page.jobs[0].category, "", "空串类别原样保留");
});

test("公司/城市非字符串仍拒绝（不静默吞类型漂移）", async () => {
  const fixture = await loadFixture();
  const payload = JSON.parse(fixture.content[0].text);
  payload.Data.list[0].client_company = 123;
  fixture.content[0].text = JSON.stringify(payload);

  assert.throws(
    () => parseUnderServedJobsResult(fixture),
    (error) => {
      assert.equal(error.code, "MCP_CONTRACT_INVALID");
      assert.match(error.message, /client_company/);
      return true;
    },
  );
});

test("权限边界业务码（403/1003/1004）映射 MCP_PERMISSION_BOUNDARY", () => {
  for (const code of [403, 1003, 1004]) {
    const fixture = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            Code: code,
            Message: "business error",
            Data: null,
          }),
        },
      ],
    };
    assert.throws(
      () => parseUnderServedJobsResult(fixture),
      (error) => error.code === "MCP_PERMISSION_BOUNDARY",
      `Code=${code} 应为权限边界`,
    );
  }
});

test("瞬时上游业务码映射 MCP_UPSTREAM_ERROR，与权限边界区分", () => {
  const fixture = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ Code: 500, Message: "upstream", Data: null }),
      },
    ],
  };
  assert.throws(
    () => parseUnderServedJobsResult(fixture),
    (error) => error.code === "MCP_UPSTREAM_ERROR",
  );
});

test("under-served Fixture 虚构化守卫：无手机号/邮箱/真实域名残留", async () => {
  const fixture = await loadFixture();
  const rawText = fixture.content[0].text;

  assert.doesNotMatch(rawText, /1[3-9]\d{9}/, "不应残留手机号");
  assert.doesNotMatch(
    rawText,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    "不应残留邮箱",
  );
  assert.doesNotMatch(rawText, /https:\/\/(?!portal\.invalid)/, "外链应统一用 portal.invalid");
  assert.ok(rawText.includes("https://portal.invalid/"), "应保留 portal.invalid 链接占位");
});

test("parseJobsListResult：解析 wb.jobs.list 响应为 externalId + jobDescription", async () => {
  const result = parseJobsListResult(await loadJobsListFixture());

  assert.equal(result.total, 2);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].externalId, "fixture-job-list-001");
  assert.equal(typeof result.jobs[0].jobDescription, "string");
  assert.match(result.jobs[0].jobDescription, /前后端开发/);
  assert.equal(result.jobs[1].externalId, "fixture-job-list-002");
});

test("parseJobsListResult：job_description 可空，job_id 缺失明确失败", async () => {
  const fixture = await loadJobsListFixture();
  const payload = JSON.parse(fixture.content[0].text);
  payload.Data.list[0].job_description = null;
  fixture.content[0].text = JSON.stringify(payload);

  const result = parseJobsListResult(fixture);
  assert.equal(result.jobs[0].jobDescription, null, "job_description 可空归一为 null");

  const fixture2 = await loadJobsListFixture();
  const payload2 = JSON.parse(fixture2.content[0].text);
  payload2.Data.list[1].job_id = "";
  fixture2.content[0].text = JSON.stringify(payload2);
  assert.throws(
    () => parseJobsListResult(fixture2),
    (error) => {
      assert.equal(error.code, "MCP_CONTRACT_INVALID");
      assert.match(error.message, /job_id/);
      return true;
    },
  );
});

test("parseJobsListResult：权限边界业务码映射 MCP_PERMISSION_BOUNDARY", () => {
  for (const code of [403, 1003, 1004]) {
    const fixture = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            Code: code,
            Message: "business error",
            Data: null,
          }),
        },
      ],
    };
    assert.throws(
      () => parseJobsListResult(fixture),
      (error) => error.code === "MCP_PERMISSION_BOUNDARY",
      `Code=${code} 应为权限边界`,
    );
  }
});

test("parseJobsListResult：瞬时上游业务码映射 MCP_UPSTREAM_ERROR", () => {
  const fixture = {
    content: [
      {
        type: "text",
        text: JSON.stringify({ Code: 500, Message: "upstream", Data: null }),
      },
    ],
  };
  assert.throws(
    () => parseJobsListResult(fixture),
    (error) => error.code === "MCP_UPSTREAM_ERROR",
  );
});

test("wb-jobs-list Fixture 虚构化守卫：无手机号/邮箱/真实域名残留", async () => {
  const fixture = await loadJobsListFixture();
  const rawText = fixture.content[0].text;

  assert.doesNotMatch(rawText, /1[3-9]\d{9}/, "不应残留手机号");
  assert.doesNotMatch(
    rawText,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    "不应残留邮箱",
  );
  assert.doesNotMatch(rawText, /https:\/\/(?!portal\.invalid)/, "外链应统一用 portal.invalid");
  assert.ok(rawText.includes("https://portal.invalid/"), "应保留 portal.invalid 链接占位");
});

test("parseMatchCandidatesResult：解析真实响应形状（score_status=pending 正常态，不视为失败）", async () => {
  const fixture = await loadMatchCandidatesFixture();
  const parsed = parseMatchCandidatesResult(fixture);
  assert.equal(parsed.sourceId, "fixture-job-001");
  assert.equal(parsed.sourceType, "job");
  assert.equal(parsed.total, 219);
  assert.equal(parsed.matches.length, 3);
  const first = parsed.matches[0];
  assert.equal(first.candidateId, "fixture-candidate-001");
  assert.equal(first.scoreStatus, "pending");
  assert.equal(first.totalScore, null, "pending 时分数为 null 属正常");
  assert.equal(first.tier, null);
  assert.equal(first.candidate.name, "张**");
  assert.equal(first.candidate.currentTitle, "产品经理");
  assert.equal(first.candidate.city, "北京市");
  // pending 时解释字段归一为 null/[]（M2 退出门禁：证据/缺失项/风险提示可空待评分完成）
  assert.equal(first.dimensionScores, null, "pending 时维度分为 null");
  assert.deepEqual(first.matchHighlights, [], "pending 时命中项为空数组");
  assert.deepEqual(first.gapAnalysis, []);
  assert.deepEqual(first.riskFlags, []);
  // 投影收敛：保留已打码摘要，不暴露 portal_url
  assert.equal("portal_url" in first.candidate, false, "不投影 portal_url");
});

test("parseMatchCandidatesResult：cached 评分（真实验证形状：total_score + tier）", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          Code: 0,
          Message: "success",
          Data: {
            source_id: "job-x",
            source_type: "job",
            total: 1,
            page: 1,
            page_size: 5,
            total_pages: 1,
            matches: [
              {
                candidate_id: "c-1",
                is_own: true,
                owner_id: "o-1",
                owner_name: "示例顾问",
                score_status: "cached",
                total_score: 78,
                tier: "moderate",
                dimension_scores: [
                  { dimension: "技能", score: 85 },
                  { dimension: "地点", score: 70 },
                ],
                match_highlights: ["候选人在搜索推荐引擎有 5 年经验"],
                gap_analysis: ["缺少海外市场经验"],
                risk_flags: ["当前在职，离职周期可能较长"],
                verification_suggestions: ["核实职级与汇报关系"],
                job_summary: "搜推引擎 leader，211 本起",
                candidate_summary: {
                  candidate_id: "c-1",
                  name: "王**",
                  current_title: "算法工程师",
                  current_company: "示例公司",
                  city: "上海",
                  experience_years: 5,
                  resume_summary: "示例公司-算法工程师",
                },
              },
            ],
          },
        }),
      },
    ],
  };
  const parsed = parseMatchCandidatesResult(result);
  const m = parsed.matches[0];
  assert.equal(m.scoreStatus, "cached");
  assert.equal(m.totalScore, 78);
  assert.equal(m.tier, "moderate");
  assert.equal(m.isOwn, true);
  // M2 退出门禁：维度分 + 证据/缺失项/风险提示三类信息透传
  assert.deepEqual(m.dimensionScores, [
    { dimension: "技能", score: 85 },
    { dimension: "地点", score: 70 },
  ]);
  assert.deepEqual(m.matchHighlights, ["候选人在搜索推荐引擎有 5 年经验"]);
  assert.deepEqual(m.gapAnalysis, ["缺少海外市场经验"]);
  assert.deepEqual(m.riskFlags, ["当前在职，离职周期可能较长"]);
  assert.equal(m.jobSummary, "搜推引擎 leader，211 本起");
});

test("parseMatchCandidatesResult：权限边界业务码（1003）映射 MCP_PERMISSION_BOUNDARY，不重试不换身份", () => {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          Code: 1003,
          Message: "Data not found",
          Data: null,
        }),
      },
    ],
  };
  assert.throws(
    () => parseMatchCandidatesResult(result),
    (error) => error.code === "MCP_PERMISSION_BOUNDARY",
  );
});

test("match-candidates Fixture 虚构化守卫：无手机号/邮箱/真实域名残留，候选人名已打码", async () => {
  const fixture = await loadMatchCandidatesFixture();
  const rawText = fixture.content[0].text;
  assert.doesNotMatch(rawText, /1[3-9]\d{9}/, "不应残留手机号");
  assert.doesNotMatch(
    rawText,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    "不应残留邮箱",
  );
  assert.doesNotMatch(rawText, /https:\/\/(?!portal\.invalid)/, "外链应统一用 portal.invalid");
  assert.ok(rawText.includes("portal.invalid"), "应保留 portal.invalid 链接占位");
  assert.match(rawText, /"[^"]*\*\*"/, "候选人名应为打码形式（含 *）");
});
