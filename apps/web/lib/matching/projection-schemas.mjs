/**
 * 匹配契约 JSON Schema 运行时校验（docs/10 §2：持久化与外部调用前必须校验）。
 *
 * 三份 v1 Schema 唯一权威来源为 `docs/contracts/`（docs/10 §1）：
 * - job-requirement-projection/v1：职位要求投影
 * - candidate-match-projection/v1：候选人脱敏匹配投影（residual_pii_scan 必须 passed）
 * - llm-detail-score/v1：LLM 脱敏详情维度评分（7 维固定枚举、assessable/score 条件约束）
 *
 * 校验失败返回 `{ ok:false, errors }`（Ajv allErrors），不抛异常——调用方决定降级路径。
 * 文档加载采用延迟单例，仅在 Node 运行环境（测试/调度管线）使用；本切片不进入 Worker 路由。
 */

import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const CONTRACT_DIR = new URL("../../../../docs/contracts/", import.meta.url);

const SCHEMA_FILES = {
  job: "job-requirement-projection.v1.schema.json",
  candidate: "candidate-match-projection.v1.schema.json",
  llm: "llm-detail-score.v1.schema.json",
};

let validatorsPromise;

/** 延迟加载并编译三份 Schema（只加载一次）。 */
async function loadValidators() {
  if (!validatorsPromise) {
    validatorsPromise = (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv);
      const [jobSchema, candidateSchema, llmSchema] = await Promise.all(
        Object.values(SCHEMA_FILES).map(async (file) =>
          JSON.parse(await readFile(new URL(file, CONTRACT_DIR), "utf8")),
        ),
      );
      return {
        job: ajv.compile(jobSchema),
        candidate: ajv.compile(candidateSchema),
        llm: ajv.compile(llmSchema),
      };
    })();
  }
  return validatorsPromise;
}

/** 校验职位要求投影文档（job-requirement-projection/v1）。 */
export async function validateJobRequirementProjection(document) {
  const { job } = await loadValidators();
  return job(document)
    ? { ok: true }
    : { ok: false, errors: job.errors ?? [] };
}

/** 校验候选人脱敏匹配投影文档（candidate-match-projection/v1）。 */
export async function validateCandidateMatchProjection(document) {
  const { candidate } = await loadValidators();
  return candidate(document)
    ? { ok: true }
    : { ok: false, errors: candidate.errors ?? [] };
}

/** 校验 LLM 脱敏详情维度评分文档（llm-detail-score/v1）。 */
export async function validateLlmDetailScore(document) {
  const { llm } = await loadValidators();
  return llm(document)
    ? { ok: true }
    : { ok: false, errors: llm.errors ?? [] };
}
