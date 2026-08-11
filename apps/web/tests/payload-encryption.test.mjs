import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptJsonPayload,
  encryptJsonPayload,
} from "../lib/security/payload-encryption.mjs";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("原始载荷使用随机 nonce 加密且可受控解密", async () => {
  const payload = { job_id: "fixture-job", company: "Fixture Company" };
  const first = await encryptJsonPayload(payload, { key, keyVersion: "test-v1" });
  const second = await encryptJsonPayload(payload, { key, keyVersion: "test-v1" });

  assert.equal(first.keyVersion, "test-v1");
  assert.equal(first.nonce.length, 12);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.doesNotMatch(
    new TextDecoder().decode(first.ciphertext),
    /Fixture Company/,
  );
  assert.deepEqual(await decryptJsonPayload(first, { key }), payload);
});

test("拒绝不是 32 字节的加密密钥", async () => {
  await assert.rejects(
    encryptJsonPayload({ value: 1 }, { key: "aW52YWxpZA==", keyVersion: "bad" }),
    /32 bytes/,
  );
});
