import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalSchemaJson,
  compareProviderSchemas,
  schemaSha256,
  verifyContractSchemas,
} from "../../../scripts/check-browser-contracts.mjs";

const requestSchema = JSON.parse(
  await readFile(
    new URL("../../../docs/contracts/liebide-job-detail.request.v1.schema.json", import.meta.url),
    "utf8",
  ),
);
const receiptSchema = JSON.parse(
  await readFile(
    new URL("../../../docs/contracts/liebide-job-detail.receipt.v1.schema.json", import.meta.url),
    "utf8",
  ),
);

test("浏览器契约 Schema 与 Consumer 常量和字段白名单一致", () => {
  const manifest = verifyContractSchemas({ requestSchema, receiptSchema });

  assert.equal(manifest.contractId, "liebide-job-detail-v1");
  assert.equal(manifest.contractVersion, 1);
  assert.match(manifest.requestSchemaSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.receiptSchemaSha256, /^[a-f0-9]{64}$/);
});

test("规范化 Schema 哈希忽略对象键顺序但拒绝语义漂移", () => {
  assert.equal(
    canonicalSchemaJson({ b: 2, a: 1 }),
    canonicalSchemaJson({ a: 1, b: 2 }),
  );
  assert.equal(schemaSha256({ b: 2, a: 1 }), schemaSha256({ a: 1, b: 2 }));

  const changedReceipt = structuredClone(receiptSchema);
  changedReceipt.properties.contractVersion.const = 2;
  assert.throws(
    () =>
      compareProviderSchemas(
        { requestSchema, receiptSchema },
        { requestSchema, receiptSchema: changedReceipt },
      ),
    /Provider receipt Schema differs/,
  );
});
