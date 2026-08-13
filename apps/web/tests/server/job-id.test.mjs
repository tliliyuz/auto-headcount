import assert from "node:assert/strict";
import test from "node:test";

import { parseJobIdFromPathname } from "../../lib/server/job-id.mjs";

const VALID_UUID = "3f2a8c1e-0000-4000-8000-000000000000";

test("合法 UUID 路径解析出 id（大小写不敏感）", () => {
  assert.equal(parseJobIdFromPathname(`/api/jobs/${VALID_UUID}`), VALID_UUID);
  assert.equal(
    parseJobIdFromPathname(`/api/jobs/${VALID_UUID.toUpperCase()}`),
    VALID_UUID,
  );
});

test("非 UUID 路径段返回 null（路由映射 400）", () => {
  assert.equal(parseJobIdFromPathname("/api/jobs/not-a-uuid"), null);
  assert.equal(parseJobIdFromPathname("/api/jobs/under-served"), null);
  assert.equal(parseJobIdFromPathname("/api/jobs/12345"), null);
});

test("路径缺 id 返回 null", () => {
  assert.equal(parseJobIdFromPathname("/api/jobs"), null);
  assert.equal(parseJobIdFromPathname("/api/jobs/"), null);
  assert.equal(parseJobIdFromPathname(""), null);
});
