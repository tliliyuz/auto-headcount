import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("服务端渲染沉睡职位运营后台", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>沉睡职位巡检｜职位激活台<\/title>/i);
  assert.match(html, /让沉睡的职位，重新流动起来。/);
  assert.match(html, /发布 7–30 天、仍有效且零推荐/);
  assert.match(html, /资深前端工程师/);
  assert.match(html, /候选人看到的内容/);
  assert.doesNotMatch(html, /海岳智能科技有限公司/);
  assert.doesNotMatch(html, /浦东新区张江路/);
});

test("静态原型覆盖完整运营后台导航页面", async () => {
  const source = await readFile(
    new URL("../app/operations-dashboard.tsx", import.meta.url),
    "utf8",
  );

  for (const pageMarker of [
    "匹配审核队列",
    "活动执行概况",
    "今日跟进",
    "转化趋势",
    "MCP 职位数据源",
    "操作审计记录",
  ]) {
    assert.match(source, new RegExp(pageMarker));
  }
});
