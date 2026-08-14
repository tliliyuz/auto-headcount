import assert from "node:assert/strict";
import test from "node:test";

import {
  bindBrowserRoute,
  BrowserRouteConfigError,
  resolveBrowserRouteConfig,
} from "../lib/server/browser-route-config.mjs";

test("浏览器批量路由只从服务端环境注入并规范化", () => {
  assert.deepEqual(
    resolveBrowserRouteConfig({
      BROWSER_RELAY_USER_ID: " fixture-user ",
      BROWSER_RELAY_DEVICE_ID: " fixture-device ",
    }),
    { userId: "fixture-user", deviceId: "fixture-device" },
  );
});

test("请求体不能覆盖服务端浏览器路由", () => {
  assert.deepEqual(
    bindBrowserRoute(
      { userId: "attacker", deviceId: "other-device", batchSize: 20 },
      { BROWSER_RELAY_USER_ID: "owner", BROWSER_RELAY_DEVICE_ID: "bound-device" },
    ),
    { userId: "owner", deviceId: "bound-device", batchSize: 20 },
  );
});

test("浏览器路由配置缺失或格式错误时失败关闭", () => {
  for (const env of [
    {},
    { BROWSER_RELAY_USER_ID: "fixture-user" },
    { BROWSER_RELAY_USER_ID: "fixture user", BROWSER_RELAY_DEVICE_ID: "fixture-device" },
  ]) {
    assert.throws(() => resolveBrowserRouteConfig(env), BrowserRouteConfigError);
  }
});
