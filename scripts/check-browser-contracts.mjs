import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LIEBIDE_JOB_DETAIL_CONTRACT_ID,
  LIEBIDE_JOB_DETAIL_CONTRACT_VERSION,
  LIEBIDE_PLATFORM_ORIGIN,
} from "../apps/web/lib/adapters/csdn-browser/browser-collection-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_SCHEMA_RELATIVE =
  "docs/contracts/liebide-job-detail.request.v1.schema.json";
const RECEIPT_SCHEMA_RELATIVE =
  "docs/contracts/liebide-job-detail.receipt.v1.schema.json";
const PROVIDER_REQUEST_RELATIVE =
  "plugins/csdn-browser-agent/contracts/liebide-job-detail.request.v1.schema.json";
const PROVIDER_RECEIPT_RELATIVE =
  "plugins/csdn-browser-agent/contracts/liebide-job-detail.receipt.v1.schema.json";
const LIST_REQUEST_SCHEMA_RELATIVE = "docs/contracts/liebide-filtered-job-list.request.v2.schema.json";
const LIST_RECEIPT_SCHEMA_RELATIVE = "docs/contracts/liebide-filtered-job-list.receipt.v2.schema.json";
const PROVIDER_LIST_REQUEST_RELATIVE = "plugins/csdn-browser-agent/contracts/liebide-filtered-job-list.request.v2.schema.json";
const PROVIDER_LIST_RECEIPT_RELATIVE = "plugins/csdn-browser-agent/contracts/liebide-filtered-job-list.receipt.v2.schema.json";

const REQUEST_KEYS = [
  "userId",
  "deviceId",
  "browserSessionId",
  "contractId",
  "expectedExternalId",
];
const REQUEST_REQUIRED_KEYS = [
  "userId",
  "deviceId",
  "contractId",
  "expectedExternalId",
];
const RECEIPT_KEYS = [
  "contractId",
  "contractVersion",
  "status",
  "source",
  "record",
  "contentHash",
];
const RECORD_KEYS = [
  "externalId",
  "title",
  "status",
  "city",
  "salaryMin",
  "salaryMax",
  "jobDescription",
  "publishedAt",
  "validRecommendationCount",
];

export function canonicalSchemaJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSchemaJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSchemaJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function schemaSha256(schema) {
  return createHash("sha256").update(canonicalSchemaJson(schema)).digest("hex");
}

export function verifyContractSchemas({ requestSchema, receiptSchema }) {
  verifyClosedObject(requestSchema, REQUEST_KEYS, "request", REQUEST_REQUIRED_KEYS);
  assert.equal(
    requestSchema.properties.contractId?.const,
    LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    "request contractId must match Consumer implementation",
  );

  verifyClosedObject(receiptSchema, RECEIPT_KEYS, "receipt");
  assert.equal(
    receiptSchema.properties.contractId?.const,
    LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    "receipt contractId must match Consumer implementation",
  );
  assert.equal(
    receiptSchema.properties.contractVersion?.const,
    LIEBIDE_JOB_DETAIL_CONTRACT_VERSION,
    "receipt contractVersion must match Consumer implementation",
  );
  assert.equal(
    receiptSchema.properties.source?.properties?.origin?.const,
    LIEBIDE_PLATFORM_ORIGIN,
    "receipt origin must match Consumer implementation",
  );
  verifyClosedObject(receiptSchema.properties.source, ["origin", "capturedAt"], "source");
  verifyClosedObject(receiptSchema.properties.record, RECORD_KEYS, "record");
  assert.equal(
    receiptSchema.properties.contentHash?.pattern,
    "^[a-f0-9]{64}$",
    "receipt contentHash must remain lowercase SHA-256",
  );

  return {
    contractId: LIEBIDE_JOB_DETAIL_CONTRACT_ID,
    contractVersion: LIEBIDE_JOB_DETAIL_CONTRACT_VERSION,
    requestSchemaSha256: schemaSha256(requestSchema),
    receiptSchemaSha256: schemaSha256(receiptSchema),
  };
}

export function compareProviderSchemas(consumer, provider) {
  assert.equal(
    schemaSha256(provider.requestSchema),
    schemaSha256(consumer.requestSchema),
    "Provider request Schema differs from Consumer Schema",
  );
  assert.equal(
    schemaSha256(provider.receiptSchema),
    schemaSha256(consumer.receiptSchema),
    "Provider receipt Schema differs from Consumer Schema",
  );
}

async function readSchema(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function main() {
  const providerIndex = process.argv.indexOf("--provider-repo");
  const providerRoot =
    providerIndex === -1 ? null : path.resolve(process.argv[providerIndex + 1] || "");
  if (providerIndex !== -1 && !process.argv[providerIndex + 1]) {
    throw new Error("--provider-repo requires a CSDN-Agent repository path");
  }

  const consumer = {
    requestSchema: await readSchema(ROOT, REQUEST_SCHEMA_RELATIVE),
    receiptSchema: await readSchema(ROOT, RECEIPT_SCHEMA_RELATIVE),
  };
  const manifest = verifyContractSchemas(consumer);
  const listConsumer = {
    requestSchema: await readSchema(ROOT, LIST_REQUEST_SCHEMA_RELATIVE),
    receiptSchema: await readSchema(ROOT, LIST_RECEIPT_SCHEMA_RELATIVE),
  };

  if (providerRoot) {
    const provider = {
      requestSchema: await readSchema(providerRoot, PROVIDER_REQUEST_RELATIVE),
      receiptSchema: await readSchema(providerRoot, PROVIDER_RECEIPT_RELATIVE),
    };
    compareProviderSchemas(consumer, provider);
    compareProviderSchemas(listConsumer, {
      requestSchema: await readSchema(providerRoot, PROVIDER_LIST_REQUEST_RELATIVE),
      receiptSchema: await readSchema(providerRoot, PROVIDER_LIST_RECEIPT_RELATIVE),
    });
  }

  console.log(
    JSON.stringify({
      ...manifest,
      listRequestSchemaSha256: schemaSha256(listConsumer.requestSchema),
      listReceiptSchemaSha256: schemaSha256(listConsumer.receiptSchema),
      providerCompared: Boolean(providerRoot),
    }),
  );
}

function verifyClosedObject(schema, expectedKeys, label, requiredKeys = expectedKeys) {
  assert.equal(schema?.type, "object", `${label} Schema must be an object`);
  assert.equal(
    schema?.additionalProperties,
    false,
    `${label} Schema must reject unknown fields`,
  );
  assert.deepEqual(
    [...(schema?.required || [])].sort(),
    [...requiredKeys].sort(),
    `${label} required keys changed`,
  );
  assert.deepEqual(
    Object.keys(schema?.properties || {}).sort(),
    [...expectedKeys].sort(),
    `${label} property whitelist changed`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`browser contract check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
