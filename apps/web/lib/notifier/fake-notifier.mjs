/**
 * 测试/开发用假 notifier：记录投递请求并返回成功，避免测试打到真实 webhook。
 * 生产环境不得配置 channel=fake（docs/06 §5：密钥与外部出口必须真实配置）。
 */
export function createFakeNotifier() {
  const sent = [];
  return {
    name: "fake",
    sent,
    async sendNotification(payload) {
      sent.push(payload);
      return { ok: true, errorCode: null };
    },
  };
}
