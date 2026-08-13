import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractDirectory = new URL("../../../docs/contracts/", import.meta.url);
const contractFiles = [
  "job-requirement-projection.v1.schema.json",
  "candidate-match-projection.v1.schema.json",
  "llm-detail-score.v1.schema.json",
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

for (const contractFile of contractFiles) {
  const contractUrl = new URL(contractFile, contractDirectory);
  const schema = JSON.parse(await readFile(contractUrl, "utf8"));

  ajv.compile(schema);
  console.log(`validated ${fileURLToPath(contractUrl)}`);
}
