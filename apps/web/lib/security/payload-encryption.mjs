const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptJsonPayload(value, { key, keyVersion }) {
  const keyBytes = decodeKey(key);
  if (typeof keyVersion !== "string" || keyVersion.trim() === "") {
    throw new Error("keyVersion is required");
  }

  const plaintext = encoder.encode(JSON.stringify(value));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext),
  );
  const payloadHash = toHex(await crypto.subtle.digest("SHA-256", plaintext));

  return {
    ciphertext,
    nonce,
    keyVersion: keyVersion.trim(),
    payloadHash,
  };
}

export async function decryptJsonPayload(
  { ciphertext, nonce },
  { key },
) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    decodeKey(key),
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
