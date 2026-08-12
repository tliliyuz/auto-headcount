import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureUrl = new URL(
  "../fixtures/mcp/match-candidates-response-2026-08-12.json",
  import.meta.url,
);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("match_candidates 脱敏 Fixture 结构与源信息完整", async () => {
  const fixture = await loadFixture();

  assert.equal(fixture.fixtureType, "sanitized-tools-call-response");
  assert.equal(fixture.source.tool, "wb.jobs.match_candidates");
  assert.equal(fixture.source.protocolVersion, "2025-11-25");
  assert.equal(fixture.source.request.job_id, "fixture-job-001");
  assert.equal(fixture.source.request.max_llm_score_count, 1);

  const payload = JSON.parse(fixture.content[0].text);
  assert.equal(payload.Code, 0);
  assert.equal(payload.Data.source_type, "job");
  assert.equal(payload.Data.total, 219);
  assert.equal(payload.Data.matches.length, 3);
});

test("match_candidates 脱敏 Fixture 已虚构化且保留评分边界", async () => {
  const fixture = await loadFixture();
  const payload = JSON.parse(fixture.content[0].text);
  const rawText = fixture.content[0].text;

  // 不残留真实 Portal 域名
  assert.ok(!rawText.includes("liebide"));

  for (const match of payload.Data.matches) {
    const summary = match.candidate_summary;
    assert.match(summary.name, /\*\*/); // 姓名打码（保留姓）
    assert.ok(summary.portal_url.startsWith("https://portal.invalid/"));
    assert.equal(match.owner_name, summary.created_by);
    assert.equal(match.score_status, "pending"); // 评分边界：待算
    assert.equal(match.total_score, null);
  }
});

test("match_candidates 脱敏 Fixture 不残留手机号或邮箱", async () => {
  const fixture = await loadFixture();
  const rawText = fixture.content[0].text;

  // 手机号（中国大陆 11 位）与邮箱模式在整个 fixture 文本中不得出现
  assert.doesNotMatch(rawText, /1[3-9]\d{9}/, "不应残留手机号");
  assert.doesNotMatch(
    rawText,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    "不应残留邮箱",
  );
});
