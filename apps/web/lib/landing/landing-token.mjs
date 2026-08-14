import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;

/**
 * 生成落地页访问令牌：高熵随机（32 字节 → base64url，约 43 字符）。
 * 明文令牌只在建链响应返回给运营一次，数据库只存 SHA-256 哈希（docs/06 §3、ADR-006）。
 */
export function generateLandingToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 落地页令牌 SHA-256 哈希（唯一索引；永不存明文令牌）。 */
export function hashLandingToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
