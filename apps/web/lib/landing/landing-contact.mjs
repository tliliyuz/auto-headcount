import { createHmac } from "node:crypto";

import {
  decryptJsonPayload,
  encryptJsonPayload,
} from "../security/payload-encryption.mjs";

/** 规范化手机号（去空白/连字符/括号），仅用于 HMAC 去重/抑制。 */
export function normalizePhone(phone) {
  return String(phone).replace(/[\s\-()]/g, "");
}

/** 规范化邮箱（去空白 + 小写），仅用于 HMAC 去重/抑制。 */
export function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

/** HMAC-SHA256（docs/03 §11：联系方式不可逆哈希仅用于去重/抑制）。 */
export function hmacValue(value, key) {
  return createHmac("sha256", key).update(value).digest("hex");
}

/**
 * 联系方式信封加密（ADR-006、docs/06 §高敏感）：encryptJsonPayload({ phone?, email? })。
 * 明文联系方式不落日志/审计/审计元数据；返回 HMAC 供去重/抑制。
 */
export async function encryptSubmittedContact(
  { phone, email },
  { key, keyVersion },
) {
  const encrypted = await encryptJsonPayload(
    { phone: phone ?? null, email: email ?? null },
    { key, keyVersion },
  );
  return {
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyVersion: encrypted.keyVersion,
    payloadHash: encrypted.payloadHash,
    phoneHmac: phone ? hmacValue(normalizePhone(phone), key) : null,
    emailHmac: email ? hmacValue(normalizeEmail(email), key) : null,
  };
}

/** 解密联系方式信封（notifier 投递用；解出值仅在内存中组装通知 payload）。 */
export async function decryptSubmittedContact(
  { ciphertext, nonce, keyVersion },
  { key },
) {
  const plaintext = await decryptJsonPayload(
    { ciphertext, nonce, keyVersion },
    { key },
  );
  return { phone: plaintext.phone ?? null, email: plaintext.email ?? null };
}
