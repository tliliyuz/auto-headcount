const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 加密 JSON 载荷：AES-256-GCM，返回密文/随机 nonce/keyVersion/明文哈希。
 * `nonce` 可选注入，仅供测试已知向量断言；生产缺省使用 WebCrypto 随机 12 字节。
 */
export async function encryptJsonPayload(value, { key, keyVersion, nonce }) {
  const keyBytes = decodeKey(key);
  if (typeof keyVersion !== "string" || keyVersion.trim() === "") {
    throw new Error("keyVersion is required");
  }

  const plaintext = encoder.encode(JSON.stringify(value));
  const iv = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
  );
  const payloadHash = toHex(await crypto.subtle.digest("SHA-256", plaintext));

  return {
    ciphertext,
    nonce: iv,
    keyVersion: keyVersion.trim(),
    payloadHash,
  };
}

/**
 * 解密 JSON 载荷：支持按 keyVersion 从 `keys` 映射选钥（密钥轮换就绪）。
 * - `keys` + 密文带 keyVersion：选 keys[keyVersion]，缺失时报错；
 * - `keys` 但密文未带版本：仅单版本时无歧义选钥，多版本必须带版本；
 * - 无 `keys`：回落单钥 `key`（向后兼容）。
 */
export async function decryptJsonPayload(
  { ciphertext, nonce, keyVersion },
  { key, keys } = {},
) {
  const resolvedKey = resolveDecryptKey({ key, keys, keyVersion });
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    decodeKey(resolvedKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext));
}

/** 按版本选钥：多钥时必须有 keyVersion，单钥时无歧义回落。 */
function resolveDecryptKey({ key, keys, keyVersion }) {
  if (keys && typeof keys === "object") {
    const versions = Object.keys(keys);
    if (typeof keyVersion === "string" && keyVersion !== "") {
      const selected = keys[keyVersion];
      if (!selected) {
        throw new Error(`no encryption key for keyVersion: ${keyVersion}`);
      }
      return selected;
    }
    if (versions.length === 1 && key === undefined) return keys[versions[0]];
    throw new Error("keyVersion is required when multiple keys configured");
  }
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("encryption key is required");
  }
  return key;
}

function decodeKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("encryption key is required");
  }
  let decoded;
  try {
    decoded = Uint8Array.from(atob(value.trim()), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    throw new Error("encryption key must be valid base64");
  }
  if (decoded.length !== 32) {
    throw new Error("encryption key must decode to exactly 32 bytes");
  }
  return decoded;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
