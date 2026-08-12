import bcrypt from "bcryptjs";

/** bcrypt 成本参数（规范允许 bcrypt，按硬件调整）。 */
export const BCRYPT_COST = 12;

/**
 * 时间均匀化用假哈希：账号不存在时也执行一次比较，
 * 避免用响应时长区分「账号不存在」与「口令错误」。
 * 该值仅为占位比较，不代表任何真实账号。
 */
export const DUMMY_BCRYPT_HASH =
  "$2b$12$o/54KukG3.fj.2/wzulWJ.FZIpRHV1lyzqLSctPYvtk80JduBtate";

/** 计算口令 bcrypt 哈希，不保存明文。 */
export function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** 常量时间比较口令与哈希。 */
export function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}
