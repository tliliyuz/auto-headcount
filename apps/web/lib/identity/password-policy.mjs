/** 口令策略：最短 12 位、含字母与数字、拒绝常见弱口令。 */

export const PASSWORD_MIN_LENGTH = 12;

const COMMON_PASSWORDS = new Set([
  "password123456",
  "123456789012",
  "qwerty123456",
  "admin12345678",
  "letmein123456",
  "123456password",
  "abcdef123456",
  "password1234abcd",
  "changeme123456",
  "welcome123456",
]);

export function validatePasswordPolicy(password) {
  if (typeof password !== "string") {
    return { ok: false, reason: "口令格式不正确" };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `口令至少 ${PASSWORD_MIN_LENGTH} 位` };
  }
  if (!/[A-Za-z]/.test(password)) {
    return { ok: false, reason: "口令需包含字母" };
  }
  if (!/\d/.test(password)) {
    return { ok: false, reason: "口令需包含数字" };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: "口令过于常见，请更换" };
  }
  return { ok: true };
}
