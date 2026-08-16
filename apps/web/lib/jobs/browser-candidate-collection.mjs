import { BrowserCollectionContractError, LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID, LIEBIDE_PLATFORM_ORIGIN, LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID } from "../adapters/csdn-browser/browser-collection-contract.mjs";
import { BrowserRelayError } from "../adapters/csdn-browser/relay-client.mjs";

const TASK_KEYS = new Set(["collectionBatchId", "collectionItemId", "sourceConnectionId", "userId", "deviceId", "contractId", "externalId", "expectedTitle"]);
const BATCH_TASK_KEYS = new Set(["batchId", "sourceConnectionId", "userId", "deviceId", "contractId", "batchSize", "maxPages", "startPage", "startOffset", "forceRefresh"]);
/** 差分发现安全阀：单批次最多调用的发现次数与累计翻页数，防止已知候选人占满列表时无限翻页。 */
const MAX_DISCOVERY_LOOP_CALLS = 10;
const MAX_DISCOVERY_TOTAL_PAGES = 60;

export class BrowserCandidateCollectionError extends Error {
  constructor(message, code = "BROWSER_CANDIDATE_TASK_INVALID") {
    super(message);
    this.name = "BrowserCandidateCollectionError";
    this.code = code;
  }
}

export function parseBrowserCandidateCollectTaskPayload(input) {
  if (!isPlainObject(input)) throw new BrowserCandidateCollectionError("task payload must be an object");
  for (const key of Object.keys(input)) {
    if (!TASK_KEYS.has(key)) throw new BrowserCandidateCollectionError(`task payload field ${key} is forbidden`);
  }
  const sourceConnectionId = requireString(input.sourceConnectionId, "sourceConnectionId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceConnectionId)) {
    throw new BrowserCandidateCollectionError("sourceConnectionId must be a UUID");
  }
  if (input.contractId !== LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID) throw new BrowserCandidateCollectionError("contractId is unsupported");
  const output = {
    sourceConnectionId,
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    externalId: requireIdentifier(input.externalId, "externalId"),
  };
  if (input.collectionBatchId !== undefined) output.collectionBatchId = requireUuid(input.collectionBatchId, "collectionBatchId");
  if (input.collectionItemId !== undefined) output.collectionItemId = requireUuid(input.collectionItemId, "collectionItemId");
  if ((output.collectionBatchId === undefined) !== (output.collectionItemId === undefined)) throw new BrowserCandidateCollectionError("collection batch and item must be provided together");
  if (input.expectedTitle !== undefined) output.expectedTitle = requireTitle(input.expectedTitle, "expectedTitle");
  return output;
}

export function parseBrowserCandidateBatchDiscoverTaskPayload(input) {
  if (!isPlainObject(input)) throw new BrowserCandidateCollectionError("task payload must be an object");
  for (const key of Object.keys(input)) if (!BATCH_TASK_KEYS.has(key)) throw new BrowserCandidateCollectionError(`task payload field ${key} is forbidden`);
  const batchId = requireUuid(input.batchId, "batchId");
  const sourceConnectionId = requireUuid(input.sourceConnectionId, "sourceConnectionId");
  if (input.contractId !== LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID) throw new BrowserCandidateCollectionError("contractId is unsupported");
  const output = {
    batchId, sourceConnectionId,
    userId: requireIdentifier(input.userId, "userId"),
    deviceId: requireIdentifier(input.deviceId, "deviceId"),
    contractId: input.contractId,
    batchSize: requireInteger(input.batchSize, "batchSize", 1, 100),
    maxPages: requireInteger(input.maxPages, "maxPages", 1, 20),
  };
  if (input.startPage !== undefined) output.startPage = requireInteger(input.startPage, "startPage", 1, 10000);
  if (input.startOffset !== undefined) output.startOffset = requireInteger(input.startOffset, "startOffset", 0, 10000);
  // forceRefresh：忽略差分跳过，把本批数量内已入库候选人一并重新采集（详情 upsert 覆盖画像）。
  if (input.forceRefresh !== undefined) output.forceRefresh = input.forceRefresh === true;
  return output;
}

/**
 * 差分发现：`batchSize` = 本批要采集的「新增 + 标题变化」候选人画像数。
 * 逐页调用人才池发现合同，跳过已入库且标题未变的候选人（计入 skippedKnown），
 * 直到凑满目标或列表到底；标题变化的已知候选人按变更重新采集（详情事务 upsert 覆盖画像）。
 */
export async function runBrowserCandidateBatchDiscovery({ task: rawTask, relayClient, repository }) {
  let task;
  try { task = parseBrowserCandidateBatchDiscoverTaskPayload(rawTask); }
  catch (error) { return failed(error.code ?? "BROWSER_CANDIDATE_TASK_INVALID", false); }
  if (!(await repository.sourceExists(task.sourceConnectionId))) return failed("BROWSER_SOURCE_NOT_FOUND", false);
  const known = new Map(
    ((await repository.findKnownCandidates({ sourceConnectionId: task.sourceConnectionId })) ?? []).map(
      (row) => [row.candidateId, row.title],
    ),
  );
  const targetCount = task.batchSize;
  try {
    // 人才池列表合同连接状态参数构建器（buildTalentPoolListConnectionStatusArguments）内部要求
    // batchSize/maxPages 存在（白名单校验），预检必须带齐，否则 BROWSER_COLLECTION_ARGUMENTS_INVALID。
    const preflightStatus = await relayClient.getConnectionStatus({
      userId: task.userId, deviceId: task.deviceId, contractId: task.contractId,
      batchSize: task.batchSize, maxPages: task.maxPages,
    });
    if (!preflightStatus.ready || preflightStatus.status !== "READY") {
      return failed(`BROWSER_${preflightStatus.status}`, false, { preflight: 1 });
    }

    const collected = [];
    let skippedKnown = 0;
    let rawSeen = 0;
    let calls = 0;
    let totalPagesVisited = 0;
    let lastStopReason = null;
    let lastNextPage = null;
    let lastNextOffset = null;
    let cursor = {
      ...(task.startPage ? { startPage: task.startPage } : {}),
      ...(task.startOffset !== undefined ? { startOffset: task.startOffset } : {}),
    };

    while (collected.length < targetCount && calls < MAX_DISCOVERY_LOOP_CALLS) {
      const route = {
        userId: task.userId, deviceId: task.deviceId, contractId: task.contractId,
        batchSize: task.batchSize, maxPages: task.maxPages, ...cursor,
      };
      const discovery = await relayClient.discoverTalentPool(route);
      calls += 1;
      totalPagesVisited += discovery.pagesVisited;
      rawSeen += discovery.items.length;
      for (const item of discovery.items) {
        if (!task.forceRefresh) {
          const knownTitle = known.get(item.candidateId);
          if (knownTitle !== undefined && normalizeTitle(knownTitle) === normalizeTitle(item.title)) {
            skippedKnown += 1;
            continue;
          }
        }
        collected.push(item);
      }
      lastStopReason = discovery.stopReason;
      lastNextPage = discovery.nextPage;
      lastNextOffset = discovery.nextOffset ?? null;
      if (collected.length >= targetCount) {
        lastStopReason = discovery.nextPage === null ? lastStopReason : "target_reached";
        break;
      }
      if (discovery.nextPage === null) break;
      cursor = { startPage: discovery.nextPage, startOffset: discovery.nextOffset ?? 0 };
      if (totalPagesVisited >= MAX_DISCOVERY_TOTAL_PAGES) break;
    }

    const saved = await repository.persistDiscovery({
      batch: task,
      discovery: {
        items: collected,
        nextPage: lastNextPage,
        nextOffset: lastNextOffset,
        stopReason: lastStopReason,
      },
      detailContractId: LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
    });
    return {
      status: "succeeded", retryable: false, ...saved,
      stats: {
        preflight: 1, pages: totalPagesVisited,
        discovered: rawSeen, newOrChanged: collected.length, skippedKnown,
        enqueued: saved.enqueuedDetails ?? collected.length,
        stopReason: lastStopReason,
      },
    };
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError) return failed(error.code, false);
    return failed("BROWSER_CANDIDATE_DISCOVER_INTERNAL_ERROR", false);
  }
}

/** 技能推断词表（启发式，非权威）：覆盖互联网技术人才池常见技术栈与职能。
 *  详情页无技能标签（2026-08-16 确认），skills 从简历正文匹配此词表兜底——
 *  与 category 标题推断兜底同理（见 memory: category-data-missing-tech-debt），
 *  推断结果是匹配输入的下界信号，不假装权威；权威数据源到位后应替换。 */
const SKILL_LEXICON_ASCII = [
  "Java", "Python", "Go", "Golang", "C++", "C#", "PHP", "JavaScript",
  "TypeScript", "Node.js", "Spring Boot", "Spring", "MyBatis", "React",
  "Vue", "Angular", "Flutter", "Swift", "Objective-C", "Kotlin", "Ruby",
  "Rust", "Scala", "Django", "Flask", "Redis", "MySQL", "PostgreSQL",
  "MongoDB", "Kafka", "RabbitMQ", "RocketMQ", "Flink", "Spark", "Hadoop",
  "Hive", "Elasticsearch", "ClickHouse", "Doris", "SQL", "ETL", "Docker",
  "Kubernetes", "Nginx", "Jenkins", "CI/CD", "DevOps", "Android", "iOS", "BI",
];
const SKILL_LEXICON_CJK = [
  "微服务", "分布式", "高并发", "容器化", "云计算", "系统架构", "消息队列",
  "中间件", "监控", "运维", "机器学习", "深度学习", "神经网络", "自然语言处理",
  "推荐系统", "算法", "大模型", "提示词", "数据挖掘", "数据仓库", "数据治理",
  "数据分析", "数据建模", "数据可视化", "数据平台", "大数据", "报表",
  "前端", "后端", "全栈", "客户端", "移动端", "项目管理", "项目经理",
  "产品经理", "产品设计", "交互设计", "用户体验", "用户研究", "运营",
  "用户运营", "内容运营", "数据运营", "增长", "投放", "商业化",
  "测试", "自动化测试", "质量保障", "安全", "风控", "供应链", "整合营销", "品牌营销",
];
const MAX_INFERRED_SKILLS = 40;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** ASCII 词表预编译：仅以非 ASCII 词符为邻才命中，避免 Java 误伤 JavaScript、
 *  C++ 前的 CJK 字符阻断词界等混排误判。 */
const SKILL_ASCII_PATTERNS = SKILL_LEXICON_ASCII.map((label) => ({
  label,
  regex: new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegex(label)}(?![A-Za-z0-9_])`,
    "i",
  ),
}));

/**
 * 从简历正文（工作/项目标题与描述）推断技能标签。纯函数可单测。
 * 返回去重后的词表命中项，封顶 MAX_INFERRED_SKILLS。
 */
export function inferSkillsFromResume(record) {
  const parts = [];
  for (const entry of record.workExperiences ?? []) {
    parts.push(entry.title, entry.description);
  }
  for (const entry of record.projects ?? []) {
    parts.push(entry.name, entry.description);
  }
  const text = parts.filter(Boolean).join("\n");
  const matched = new Set();
  for (const { label, regex } of SKILL_ASCII_PATTERNS) {
    if (regex.test(text)) matched.add(label);
  }
  for (const label of SKILL_LEXICON_CJK) {
    if (text.includes(label)) matched.add(label);
  }
  return [...matched].slice(0, MAX_INFERRED_SKILLS);
}

/** 候选画像 skills：优先详情回执权威 skills；详情页无技能标签时为空，回落简历正文推断。 */
function inferCandidateSkills(record) {
  const authoritative = Array.isArray(record.skills)
    ? record.skills.map((skill) => skill.trim()).filter(Boolean)
    : [];
  if (authoritative.length > 0) return authoritative;
  return inferSkillsFromResume(record);
}

/** 把候选人详情回执映射为 candidates/candidate_profiles 写参；真实姓名入 candidates，联系方式已失败关闭。 */
export function mapCandidateRecordToEntities(record) {
  return {
    candidate: {
      externalId: record.candidateId,
      displayName: record.realName,
      summary: null,
    },
    profile: {
      experienceYears: record.yearOfExperience,
      location: record.cityName,
      education: record.degree,
      school: record.school ?? null,
      major: record.major ?? null,
      seniority: record.title ?? null,
      industry: record.industry?.trim() ? record.industry : null,
      skills: inferCandidateSkills(record),
      currentTitle: record.title ?? null,
      currentCompany: record.company ?? null,
      activityUpdatedAt: record.capturedAt,
    },
  };
}

export async function runBrowserCandidateCollection({ task: rawTask, relayClient, repository }) {
  let task;
  try {
    task = parseBrowserCandidateCollectTaskPayload(rawTask);
  } catch (error) {
    return failed(error.code ?? "BROWSER_CANDIDATE_TASK_INVALID", false);
  }
  if (!(await repository.sourceExists(task.sourceConnectionId))) return failed("BROWSER_SOURCE_NOT_FOUND", false);
  const route = {
    userId: task.userId,
    deviceId: task.deviceId,
    expectedCandidateId: task.externalId,
    ...(task.expectedTitle ? { expectedTitle: task.expectedTitle } : {}),
  };
  try {
    const status = await relayClient.getConnectionStatus({
      ...route,
      contractId: LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
    });
    const ready = status.ready && status.status === "READY";
    const mayNavigateDeterministically =
      status.status === "WRONG_ENTITY" &&
      status.sessionMatched === true &&
      status.origin === LIEBIDE_PLATFORM_ORIGIN &&
      status.authState === "authenticated";
    if (!ready && !mayNavigateDeterministically) {
      return failed(`BROWSER_${status.status}`, false, { preflight: 1 });
    }
    const record = await relayClient.extractCandidateDetail(route);
    if (record.candidateId !== task.externalId) return failed("BROWSER_ENTITY_MISMATCH", false, { preflight: 1, extracted: 1 });
    const { candidate, profile } = mapCandidateRecordToEntities(record);
    const saved = await repository.persist({
      sourceConnectionId: task.sourceConnectionId,
      contractId: task.contractId,
      record,
      candidate,
      profile,
    });
    return {
      status: "succeeded", retryable: false, ...saved,
      stats: { preflight: 1, extracted: 1, eligible: 1, persisted: 1, skipped: 0 },
    };
  } catch (error) {
    if (error instanceof BrowserRelayError) return failed(error.code, error.code === "BROWSER_RELAY_UNAVAILABLE");
    if (error instanceof BrowserCollectionContractError) return failed(error.code, false);
    return failed("BROWSER_CANDIDATE_COLLECT_INTERNAL_ERROR", false);
  }
}

function failed(errorCode, retryable, stats = null) {
  return { status: "failed", errorCode, retryable, stats };
}

/** 标题变化检测：与详情合同 `expectedTitle` 校验一致的空白归一（折叠空白），避免纯空白差异触发重采。 */
function normalizeTitle(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new BrowserCandidateCollectionError(`${field} is required`);
  return value.trim();
}

function requireIdentifier(value, field) {
  const result = requireString(value, field);
  if (result.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(result)) throw new BrowserCandidateCollectionError(`${field} is invalid`);
  return result;
}

function requireTitle(value, field) {
  const result = requireString(value, field);
  if (result.length > 500) throw new BrowserCandidateCollectionError(`${field} is too long`);
  return result;
}

function requireUuid(value, field) {
  const result = requireString(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) throw new BrowserCandidateCollectionError(`${field} must be a UUID`);
  return result;
}

function requireInteger(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new BrowserCandidateCollectionError(`${field} must be between ${min} and ${max}`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
