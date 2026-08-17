import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFunctionalTracks,
  scoreFunctionalTracks,
} from "../../lib/matching/functional-track.mjs";

test("职能方向提取：标题/JD 命中多方向，ASCII 词界 + CJK 子串，Top-2 按命中强度收窄", () => {
  // 算法AI 命中 2（知识图谱/Text2SQL）> 数据 1 > 工程研发 1 → 只取前 2
  assert.deepEqual(
    extractFunctionalTracks("知识图谱/Text2SQL数据智能工程师"),
    ["算法AI", "数据"],
  );
  // 工程研发 命中 2（工程师/开发）> 数据 1（数据开发）
  assert.deepEqual(extractFunctionalTracks("数据开发工程师"), ["工程研发", "数据"]);
  // 并列命中保持词表顺序（数据工程师 各命中 1 → 数据 在 工程研发 前）
  assert.deepEqual(extractFunctionalTracks("数据工程师"), ["数据", "工程研发"]);
  assert.deepEqual(extractFunctionalTracks("产品经理（财务方向）"), ["产品"]);
  assert.deepEqual(extractFunctionalTracks("ETL 开发"), ["数据", "工程研发"]);
  // 宽职位命中多个方向 → 只取命中强度 Top-2（数据 3 命中 > 算法 1，工程/运营 未命中）
  assert.deepEqual(
    extractFunctionalTracks("供应链算法资深经理/专家，负责数据仓库与数据智能平台建设"),
    ["数据", "算法AI"],
  );
  // ASCII 词界：BI 命中、BIA 不命中；NLP 命中
  assert.deepEqual(extractFunctionalTracks("BI 分析"), ["数据"]);
  assert.deepEqual(extractFunctionalTracks("BIA 平台"), []);
  assert.deepEqual(extractFunctionalTracks("NLP 算法工程师"), ["算法AI", "工程研发"]);
  // 多来源文本拼接（标题 + JD）
  assert.deepEqual(
    extractFunctionalTracks(["数据开发工程师", "负责数据仓库建设"]),
    ["数据", "工程研发"],
  );
});

test("职能方向提取：无命中返回空数组，空输入安全", () => {
  assert.deepEqual(extractFunctionalTracks(""), []);
  assert.deepEqual(extractFunctionalTracks(null), []);
  assert.deepEqual(extractFunctionalTracks("PM"), []);
  assert.deepEqual(extractFunctionalTracks(["", null]), []);
});

test("职能方向比对：有交集 90 / 都有值无交集 65 / 任一侧空不可评估", () => {
  assert.equal(scoreFunctionalTracks({ jobTracks: ["数据"], candidateTracks: ["数据"] }), 90);
  assert.equal(
    scoreFunctionalTracks({ jobTracks: ["数据", "算法AI"], candidateTracks: ["算法AI"] }),
    90,
  );
  assert.equal(
    scoreFunctionalTracks({ jobTracks: ["数据"], candidateTracks: ["工程研发"] }),
    65,
  );
  assert.equal(scoreFunctionalTracks({ jobTracks: [], candidateTracks: ["数据"] }), null);
  assert.equal(scoreFunctionalTracks({ jobTracks: ["数据"], candidateTracks: [] }), null);
  assert.equal(scoreFunctionalTracks({ jobTracks: null, candidateTracks: ["数据"] }), null);
});
