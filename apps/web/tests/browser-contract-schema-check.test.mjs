import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalSchemaJson,
  compareProviderSchemas,
  schemaSha256,
  verifyContractSchemas,
  verifyContractV2Schemas,
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
const requestV2Schema = JSON.parse(
  await readFile(
    new URL("../../../docs/contracts/liebide-job-detail.request.v2.schema.json", import.meta.url),
    "utf8",
  ),
);
const receiptV2Schema = JSON.parse(
  await readFile(
    new URL("../../../docs/contracts/liebide-job-detail.receipt.v2.schema.json", import.meta.url),
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

test("v2 详情契约 Schema 声明 jobDescriptionMissing 且 jobDescription 可空", () => {
  const manifest = verifyContractV2Schemas({
    requestSchema: requestV2Schema,
    receiptSchema: receiptV2Schema,
  });

  assert.equal(manifest.contractId, "liebide-job-detail-v2");
  assert.equal(manifest.contractVersion, 2);
  const record = receiptV2Schema.properties.record.properties;
  assert.equal(record.jobDescriptionMissing.type, "boolean");
  assert.ok(record.jobDescription.type.includes("null"));
  assert.ok(receiptV2Schema.properties.record.required.includes("jobDescriptionMissing"));
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
