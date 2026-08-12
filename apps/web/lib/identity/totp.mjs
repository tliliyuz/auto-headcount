/**
 * RFC 6238 基于时间的一次性口令（TOTP），HMAC-SHA1、默认 6 位、30 秒步长。
 * 用户表保存 base32 编码的共享密钥；验证支持 ±window 步时间窗口。
 * 实现使用 WebCrypto，Node 与 Worker 通用。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input) {
  const bits = [];
  for (const char of input.toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new TypeError(`无效的 Base32 字符：${char}`);
    for (let bit = 4; bit >= 0; bit -= 1) bits.push((value >> bit) & 1);
  }
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length; i += 1) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i * 8 + j];
    bytes[i] = value;
  }
  return bytes;
}

/** RFC 4226 HOTP：基于计数器的 6 位码（动态截断）。 */
async function hotp(secretBytes, counter) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(4, counter >>> 0);
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(buffer));
  const bytes = new Uint8Array(signature);
  const offset = bytes[bytes.length - 1] & 0x0f;
  const binary =
    ((bytes[offset] & 0x7f) << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];
  return binary % 10 ** 6;
}

/** 生成当前时刻的 TOTP 码。now 为毫秒时间戳（测试可注入）。 */
export async function generateTOTP(
  secret,
  { now = Date.now(), step = 30, digits = 6 } = {},
) {
  const counter = Math.floor(now / 1000 / step);
  const value = await hotp(decodeBase32(secret), counter);
  return String(value).padStart(digits, "0");
}

/** 校验 TOTP 码，接受 ±window 步窗口，拒绝错误码。 */
export async function verifyTOTP(
  secret,
  code,
  { now = Date.now(), step = 30, window = 1, digits = 6 } = {},
) {
  if (typeof code !== "string" || !/^\d{1,10}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / step);
  const secretBytes = decodeBase32(secret);
  for (let offset = -window; offset <= window; offset += 1) {
    const value = await hotp(secretBytes, counter + offset);
    const candidate = String(value % 10 ** digits).padStart(digits, "0");
    if (candidate === code) return true;
  }
  return false;
}

/**
 * 生成随机 TOTP 共享密钥：20 字节（160 位，RFC 4226 推荐），base32 编码无填充。
 * 供初始化脚本在创建生产管理员时预置，操作者录入认证器 App 后即可登录。
 */
export function generateTOTPSecret() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      out += BASE32_ALPHABET[(bits >>> (bitCount - 5)) & 0x1f];
      bitCount -= 5;
    }
  }
  return out;
}

/**
 * 生成 otpauth:// 配置 URI（供二维码或手动录入）。
 * 格式：otpauth://totp/{issuer}:{accountName}?secret=...&issuer=...
 */
export function totpProvisioningUri({ secret, accountName, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({ secret, issuer });
  return `otpauth://totp/${label}?${params.toString()}`;
}
