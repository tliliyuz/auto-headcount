import { createFakeNotifier } from "./fake-notifier.mjs";
import { createFeishuNotifier } from "./feishu-notifier.mjs";

/**
 * notifier 适配器工厂（ADR-006）：业务模块不依赖飞书原始字段。
 * - channel="fake"（测试/开发显式配置）→ 假投递并记录；
 * - 配置 FEISHU_WEBHOOK_URL → 飞书群机器人；
 * - 均未配置 → 诚实失败的 null notifier（NOTIFIER_NOT_CONFIGURED），
 *   生产未配置 webhook 时意向照常落库、notify_status=failed。
 */
export function createNotifier(config = {}) {
  if (config.channel === "fake") return createFakeNotifier();
  if (config.feishuWebhookUrl) return createFeishuNotifier(config);
  return {
    name: "null",
    async sendNotification() {
      return { ok: false, errorCode: "NOTIFIER_NOT_CONFIGURED" };
    },
  };
}
