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

test("AES-256-GCM 已知向量：固定 key+nonce 断言密文与哈希（回归护栏）", async () => {
  // 期望值由独立实现（node:crypto aes-256-gcm）对同一 key/nonce/明文计算。
  const nonce = Buffer.from("0102030405060708090a0b0c", "hex");
  const payload = { job_id: "fixture-job", company: "Fixture Company" };
  const encrypted = await encryptJsonPayload(payload, {
    key,
    keyVersion: "test-v1",
    nonce,
  });

  assert.equal(
    Buffer.from(encrypted.ciphertext).toString("hex"),
    "4666bd4d45261deea167943e92fa00eb96f223d696ce12422853adeee49bf6ef49dd0b392a1a929d88a7a061f9d9ed78664ffd511fdef78f4e65b63e7df429682cb48ec0",
    "密文（含 GCM tag）应与已知向量一致",
  );
  assert.equal(
    encrypted.payloadHash,
    "45af5139afaa36a09a467c9bb44f1571dea53d9a34cc8bf2bb305eb810b6881f",
  );
  assert.deepEqual(await decryptJsonPayload(encrypted, { key }), payload);
});

test("decrypt 按 keyVersion 从 keys 选钥；错钥/缺版本明确失败", async () => {
  const payload = { job_id: "v1-job", company: "Fixture Company" };
  const keyV1 = key;
  const keyV2 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="; // 1..32
  const encrypted = await encryptJsonPayload(payload, {
    key: keyV1,
    keyVersion: "v1",
  });

  // 命中版本选钥
  assert.deepEqual(
    await decryptJsonPayload(encrypted, { keys: { v1: keyV1, v2: keyV2 } }),
    payload,
  );
  // 错钥（版本指向错误密钥）→ 解密失败（GCM 认证标签不匹配，WebCrypto 抛 OperationError）
  await assert.rejects(
    decryptJsonPayload(encrypted, { keys: { v1: keyV2, v2: keyV1 } }),
  );
  // 多钥但密文未带版本 → 明确要求版本
  await assert.rejects(
    decryptJsonPayload(
      { ...encrypted, keyVersion: undefined },
      { keys: { v1: keyV1, v2: keyV2 } },
    ),
    /keyVersion is required/,
  );
  // 单钥无版本无歧义回落
  assert.deepEqual(
    await decryptJsonPayload({ ...encrypted, keyVersion: undefined }, { keys: { v1: keyV1 } }),
    payload,
  );
  // 未知版本 → 明确报错
  await assert.rejects(
    decryptJsonPayload(encrypted, { keys: { v9: keyV1 } }),
    /no encryption key for keyVersion: v1/,
  );
});
