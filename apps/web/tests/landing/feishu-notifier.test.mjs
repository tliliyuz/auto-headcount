import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createFeishuNotifier,
  optionLabel,
  signFeishu,
} from "../../lib/notifier/feishu-notifier.mjs";

test("飞书签名：`timestamp\\nsecret` HMAC-SHA256 → base64（自定义机器人安全设置签名校验）", () => {
  const sign = signFeishu("1700000000", "secret");
  const expected = createHmac("sha256", "secret")
    .update("1700000000\nsecret")
    .digest("base64");
  assert.equal(sign, expected);
});

test("意向选项标签", () => {
  assert.equal(optionLabel("A"), "有兴趣，请联系我");
  assert.equal(optionLabel("B"), "暂不考虑");
  assert.equal(optionLabel("C"), "愿意了解更多/开放查看");
  assert.equal(optionLabel("opt_out"), "退订，不再联系");
});

test("飞书通知：POST 最小化 payload（联系方式+意向+职位+时间），不含公司名/JD/令牌", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  try {
    const notifier = createFeishuNotifier({
      webhookUrl: "https://open.feishu.cn/webhook/x",
      webhookSecret: "secret",
    });
    const result = await notifier.sendNotification({
      contact: { phone: "13800138000", email: "a@example.com" },
      option: "A",
      jobTitle: "高级前端工程师",
      submittedAt: "2026-08-14T10:00:00.000Z",
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, "https://open.feishu.cn/webhook/x");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");

    const body = JSON.parse(init.body);
    assert.equal(body.msg_type, "text");
    assert.ok(body.sign, "带签名");
    assert.ok(body.timestamp, "带时间戳");
    const text = body.content.text;
    assert.ok(text.includes("有兴趣，请联系我"));
    assert.ok(text.includes("高级前端工程师"));
    assert.ok(text.includes("13800138000"));
    assert.ok(text.includes("a@example.com"));
    assert.ok(!text.includes("某大厂"), "不含公司名");
    assert.ok(!text.includes("token"), "不含令牌");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("飞书通知：非 2xx → NOTIFY_HTTP_<status>", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  try {
    const notifier = createFeishuNotifier({
      webhookUrl: "https://open.feishu.cn/webhook/x",
      webhookSecret: "s",
    });
    const result = await notifier.sendNotification({
      contact: { phone: "1" },
      option: "B",
      jobTitle: "x",
      submittedAt: "t",
    });
    assert.deepEqual(result, { ok: false, errorCode: "NOTIFY_HTTP_500" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("飞书通知：fetch 抛错 → NOTIFY_UNREACHABLE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const notifier = createFeishuNotifier({
      webhookUrl: "https://open.feishu.cn/webhook/x",
      webhookSecret: "s",
    });
    const result = await notifier.sendNotification({
      contact: { phone: "1" },
      option: "C",
      jobTitle: "x",
      submittedAt: "t",
    });
    assert.deepEqual(result, { ok: false, errorCode: "NOTIFY_UNREACHABLE" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
