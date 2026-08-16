/**
 * 候选人脱敏详情装载器（M3 阶段一真实候选人输入桥，docs/10 §6）。
 *
 * 把采集入库的候选人画像工作经历（`raw_records` 加密载荷里的 `workExperiences:
 * [{company,title}]`）组装成匹配投影消费的脱敏 `career_history`（docs/10 §4.1：
 * 公司名默认泛化，v1 不放行真实公司名）。这是「候选人采集数据 → candidate_match_
 * projections」缺失的转换点：此前调度路径不传 `candidateRedactedDetails`，所有真实
 * 候选人都被 `runProjectionFilterSync` 计为 piiRejected 跳过。
 *
 * 脱敏语义（docs/10 §4.1）：
 * - 公司名**完全替换**为固定占位「某公司」（采集侧 `company` 保留真实公司，仅投影层泛化；
 *   `industry` 取详情页职业方向 title-text，不包含公司名，避免经投影泄漏给匹配 LLM）；
 * - 保留职位名 title（非直接身份标识）；
 * - `project_highlights` 恒 `[]`（无数据源，顺延 ingestion ticket 阶段）；
 * - 候选投影生成器还会再做一次确定性残留 PII 扫描（`scanResidualPii`），
 *   career_history 含地址字符（如「区域经理」含「区」）会触发 `detailed_address`
 *   fail-closed，投影被拒计 piiRejected（不改文案、不剥字符）。
 *
 * 过滤语义：无 raw_record / 解密失败 / 载荷无 workExperiences / 空 career_history
 * 的候选人不进 Map，保持「无脱敏详情来源 → piiRejected」语义（`async-task-sync`
 * 既有断言依赖）。单条解密失败不阻塞整批（仿 candidate-read-repository）。
 */

import { decryptJsonPayload } from "../security/payload-encryption.mjs";

export const REDACTED_COMPANY_PLACEHOLDER = "某公司";
export const DEFAULT_CAREER_HISTORY_MAX_ITEMS = 30;
const CAREER_HISTORY_ITEM_MAX_LENGTH = 1000;

/**
 * 纯函数：`workExperiences` → 脱敏 `career_history` 字符串数组。
 * - 仅保留 title 非空（trim 后）的条目；文本 = `某公司 · ${title}`；
 * - 逐条超 1000 字符丢弃（避免 schema 校验失败被错标成 piiRejected）；
 * - 去重 + 排序（稳定，供测试 deepEqual 与 input_hash 确定性）；
 * - 截断到 `maxItems`（默认 30，对齐 candidate-match-projection/v1 上限）。
 * @param {Array<{company?: string|null, title?: string|null}>} [workExperiences]
 * @param {{ maxItems?: number }} [options]
 * @returns {string[]}
 */
export function buildRedactedCareerHistory(
  workExperiences,
  { maxItems = DEFAULT_CAREER_HISTORY_MAX_ITEMS } = {},
) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(workExperiences) ? workExperiences : []) {
    const title = entry?.title?.trim();
    if (!title) continue;
    const text = `${REDACTED_COMPANY_PLACEHOLDER} · ${title}`;
    if (text.length > CAREER_HISTORY_ITEM_MAX_LENGTH) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out.sort();
}

/**
 * 载入全部「有 raw_record 的候选人」的脱敏详情 Map（candidateId → redactedDetail）。
 * 仅在存在 ≥1 条有效工作经历条目时入 Map；否则该候选人不消费（piiRejected 语义）。
 * @param {object} sql - postgres client
 * @param {{ encryption: { key: string, keyVersion: string } }} input
 * @returns {Promise<Map<string, { career_history: string[], project_highlights: string[] }>>}
 */
export async function loadCandidateRedactedDetails(sql, { encryption }) {
  const rows = await sql`
    select
      c.id as "candidateId",
      r.payload_ciphertext as "payloadCiphertext",
      r.payload_nonce as "payloadNonce",
      r.key_version as "keyVersion"
    from candidates c
    join raw_records r on r.id = c.raw_record_id
    where r.entity_type = 'candidate'
    order by c.id
  `;

  const map = new Map();
  for (const row of rows) {
    let plain;
    try {
      plain = await decryptJsonPayload(
        {
          ciphertext: row.payloadCiphertext,
          nonce: row.payloadNonce,
          keyVersion: row.keyVersion,
        },
        { key: encryption.key },
      );
    } catch {
      // 解密失败（密钥轮换/数据异常）→ 该候选人不入 Map，不阻塞整批
      continue;
    }
    if (!Array.isArray(plain?.workExperiences)) continue;
    const career_history = buildRedactedCareerHistory(plain.workExperiences);
    if (career_history.length === 0) continue;
    map.set(row.candidateId, { career_history, project_highlights: [] });
  }
  return map;
}
