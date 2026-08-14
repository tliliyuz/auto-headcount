import { createHmac } from "node:crypto";

const HTTP_TIMEOUT_MS = 3000;

/** 意向选项 → 中文标签（ADR-006 最小化 payload 的展示文案）。 */
export function optionLabel(option) {
  switch (option) {
    case "A":
      return "有兴趣，请联系我";
    case "B":
      return "暂不考虑";
    case "C":
      return "愿意了解更多/开放查看";
    case "opt_out":
      return "退订，不再联系";
    default:
      return String(option);
  }
}

/** 飞书群机器人签名：`timestamp\nsecret` HMAC-SHA256 → base64（自定义机器人安全设置-签名校验）。 */
export function signFeishu(timestamp, secret) {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
}

/**
 * 飞书群机器人 notifier（ADR-006 第一实现）。webhook URL 与签名 secret 来自部署密钥
 * （环境变量，gitignored），不入 Git/日志/审计。payload 最小化：联系方式 + 意向 + 职位 + 时间；
 * 不发送完整 JD、简历、公司名、内部编号、令牌或后台画像字段。联系方式明文仅存在于
 * 本次 webhook 请求体，不写日志/审计。
 */
export function createFeishuNotifier({ webhookUrl, webhookSecret }) {
  return {
    name: "feishu",
    async sendNotification({ contact, option, jobTitle, candidateName, submittedAt }) {
      const lines = [
        `【意向反馈】${optionLabel(option)}`,
        `职位：${jobTitle}`,
        ...(candidateName ? [`候选人：${candidateName}`] : []),
        ...(contact?.phone ? [`电话：${contact.phone}`] : []),
        ...(contact?.email ? [`邮箱：${contact.email}`] : []),
        `时间：${submittedAt}`,
      ].filter(Boolean);

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sign = signFeishu(timestamp, webhookSecret);

      let response;
      try {
        response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timestamp,
            sign,
            msg_type: "text",
            content: { text: lines.join("\n") },
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, errorCode: "NOTIFY_UNREACHABLE" };
      }
      if (!response.ok) {
        return { ok: false, errorCode: `NOTIFY_HTTP_${response.status}` };
      }
      return { ok: true, errorCode: null };
    },
  };
}
