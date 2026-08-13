import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseUnderServedJobsResult,
  selectEligibleUnderServedJobs,
  selectEligibleUnderServedPairs,
} from "../lib/adapters/mcp-under-served-contract.mjs";

const fixtureUrl = new URL(
  "../fixtures/mcp/under-served-response-2026-08-11.json",
  import.meta.url,
);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
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
