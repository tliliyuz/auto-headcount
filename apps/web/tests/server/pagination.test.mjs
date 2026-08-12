import assert from "node:assert/strict";
import test from "node:test";

import { parsePagination } from "../../lib/server/pagination.mjs";

test("缺省分页：page=1、page_size=默认 20", () => {
  assert.deepEqual(parsePagination(new URL("http://x/api/jobs")), {
    ok: true,
    page: 1,
    pageSize: 20,
  });
});

test("显式参数生效，且 page_size 上限夹取为 100", () => {
  assert.deepEqual(
    parsePagination(new URL("http://x/api/jobs?page=2&page_size=500")),
    { ok: true, page: 2, pageSize: 100 },
  );
  assert.deepEqual(
    parsePagination(new URL("http://x/api/jobs?page_size=10")),
    { ok: true, page: 1, pageSize: 10 },
  );
});

test("自定义默认分页大小生效", () => {
  assert.deepEqual(
    parsePagination(new URL("http://x/api/jobs"), { defaultPageSize: 50 }),
    { ok: true, page: 1, pageSize: 50 },
  );
});

test("非法 page / page_size 返回明确失败原因", () => {
  for (const raw of [
    "http://x/api/jobs?page=0",
    "http://x/api/jobs?page=-1",
    "http://x/api/jobs?page=abc",
    "http://x/api/jobs?page_size=0",
    "http://x/api/jobs?page_size=1.5",
  ]) {
    const result = parsePagination(new URL(raw));
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  }
});

test("超大 page 明确拒绝，防止 offset 溢出 bigint", () => {
  const result = parsePagination(new URL("http://x/api/jobs?page=1000001"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /不能超过/);

  // 边界值仍放行
  assert.equal(
    parsePagination(new URL("http://x/api/jobs?page=1000000")).ok,
    true,
  );
  // 可自定义上限
  assert.equal(
    parsePagination(new URL("http://x/api/jobs?page=3"), { maxPage: 2 }).ok,
    false,
  );
});
