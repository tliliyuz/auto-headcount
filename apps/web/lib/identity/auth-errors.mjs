/** 认证领域错误：机器码 + 人读文案，路由层据此映射 HTTP 状态与响应。 */
export const AUTH_ERROR_CODES = Object.freeze({
  invalidCredentials: "invalid_credentials",
  locked: "account_locked",
  totpRequired: "totp_required",
  passwordPolicy: "password_policy_violation",
  unauthorized: "unauthorized",
  invalidRequest: "invalid_request",
});

export class AuthError extends Error {
  /**
   * @param {string} code AUTH_ERROR_CODES 中的机器码
   * @param {string} message 人读文案
   */
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
