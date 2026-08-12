import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 显式声明非生产环境：vite 构建会把 process.env.NODE_ENV 烘焙为 "production"，
// 而 `x-prototype-view` 覆盖仅在非生产环境生效（N9 环境门禁），
// 测试须在 development 语境下验证两个视图的 SSR 渲染。
process.env.APP_ENV = "development";

// 说明（I11 守卫定位）：下述 SSR `doesNotMatch` 属名义性烟雾检查——SSR 阶段不携带
// 业务数据（职位/候选人由客户端在挂载后经 /api/* 拉取），故断言必然通过，
// 不能作为脱敏守卫的证据。权威的脱敏守卫在逻辑层：`lib/job-rules.mjs` 的
// `toPublicJobView`（公司固定标签、城市级、薪资范围），其断言见
// `tests/job-rules.test.mjs`「候选人落地页投影隐藏公司与详细地址」。

async function render(view = "login") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const headers = { accept: "text/html" };
  if (view === "app") headers["x-prototype-view"] = "app";

  return worker.fetch(
    new Request("http://localhost/", { headers }),
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

test("服务端渲染登录页（默认初始视图）", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>登录｜职位激活台<\/title>/i);
  assert.match(html, /登录职位激活台/);
  assert.match(html, /请输入账号/);
  assert.match(html, /请输入口令/);
  assert.match(html, /动态验证码/);
  assert.match(html, /开发提示/);
  assert.doesNotMatch(html, /海岳智能科技有限公司/);
  assert.doesNotMatch(html, /浦东新区张江路/);
});

test("服务端渲染运营后台不泄漏公司与详细地址", async () => {
  const response = await render("app");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>沉睡职位巡检｜职位激活台<\/title>/i);
  assert.match(html, /让沉睡的职位，重新流动起来。/);
  assert.match(html, /发布 7–30 天、仍有效且零推荐/);
  assert.match(html, /正在加载职位…/);
  assert.match(html, /候选人看到的内容/);
  assert.doesNotMatch(html, /海岳智能科技有限公司/);
  assert.doesNotMatch(html, /浦东新区张江路/);
});

test("静态原型覆盖登录页与运营后台导航页面", async () => {
  const source = await readFile(
    new URL("../app/operations-dashboard.tsx", import.meta.url),
    "utf8",
  );

  for (const pageMarker of [
    "登录职位激活台",
    "设置新口令",
    "账号或口令不正确",
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
