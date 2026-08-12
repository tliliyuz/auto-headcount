/** 服务端会话令牌：随机高熵令牌只经 Cookie 下发，数据库只存 SHA-256 哈希。 */

export const SESSION_COOKIE_NAME = "session_token";
export const SESSION_IDLE_MS = 30 * 60 * 1000; // 空闲 30 分钟
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 最长 12 小时

const TOKEN_BYTES = 32;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成 32 字节随机令牌及其哈希（WebCrypto，Node 与 Worker 通用）。 */
export async function generateSessionToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const tokenHash = await hashSessionToken(token);
  return { token, tokenHash };
}

/** 令牌的 SHA-256 哈希，入库用。 */
export async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return hex(new Uint8Array(digest));
}

/**
 * 生成会话 Cookie 值。Secure 仅在生产强制；开发环境经 http 访问需关闭，
 * 否则浏览器不会保存 Cookie（SameSite=Lax 常量时间即失效）。
 */
export function sessionCookieValue(token, { maxAgeSeconds, secure }) {
  const secureAttr = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=${maxAgeSeconds}`;
}

/** 登出/撤销时立即过期的同属性 Cookie。 */
export function clearSessionCookie({ secure = true } = {}) {
  const secureAttr = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=0`;
}

/** 从请求 Cookie 头解析会话令牌，缺失返回 null。 */
export function parseSessionToken(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}
