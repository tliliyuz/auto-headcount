import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const connectionEnvironment = pgEnum("connection_environment", [
  "development",
  "test",
  "production",
]);

export const connectionStatus = pgEnum("connection_status", [
  "disabled",
  "active",
  "error",
]);

export const syncRunStatus = pgEnum("sync_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export const rawRecordStatus = pgEnum("raw_record_status", [
  "captured",
  "normalized",
  "invalid",
]);

export const userRole = pgEnum("user_role", [
  "operations",
  "recruiter",
  "admin",
]);

export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    status: text("status").default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("organizations_name_unique").on(table.name)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    username: text("username").notNull(),
    status: userStatus("status").default("active").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: timestamp("password_changed_at", {
      withTimezone: true,
    }),
    mustChangePassword: boolean("must_change_password")
      .default(false)
      .notNull(),
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").default(false).notNull(),
    failedAttempts: integer("failed_attempts").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    index("users_organization_idx").on(table.organizationId),
  ],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: userRole("role").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("role_assignments_user_role_unique").on(
      table.userId,
      table.role,
    ),
    index("role_assignments_user_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

// 注意：audit_logs 存在 DB 级追加写触发器 `guard_audit_logs`（UPDATE 无条件拒绝、
// DELETE 需事务内设 app.audit_retention=on），由迁移 0003_complete_wallop 维护。
// Drizzle schema 无法表达触发器，drizzle-kit generate 不会重建它——重建库/新环境时
// 该守卫随 0003 迁移持久生效，切勿在此表定义中显式 delete 路径。
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    result: text("result").notNull(),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    index("audit_logs_actor_action_idx").on(table.actorType, table.action),
    index("audit_logs_occurred_at_idx").on(table.occurredAt),
  ],
);

export const sourceConnections = pgTable(
  "source_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    environment: connectionEnvironment("environment").notNull(),
    status: connectionStatus("status").default("disabled").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("source_connections_provider_environment_unique").on(
      table.provider,
      table.environment,
    ),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceConnectionId: uuid("source_connection_id")
      .notNull()
      .references(() => sourceConnections.id, { onDelete: "restrict" }),
    syncType: text("sync_type").notNull(),
    cursor: text("cursor"),
    status: syncRunStatus("status").default("pending").notNull(),
    stats: jsonb("stats").$type<Record<string, number>>().default({}).notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("sync_runs_source_created_idx").on(
      table.sourceConnectionId,
      table.createdAt,
    ),
    index("sync_runs_status_idx").on(table.status),
  ],
);

export const rawRecords = pgTable(
  "raw_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "restrict" }),
    sourceConnectionId: uuid("source_connection_id")
      .notNull()
      .references(() => sourceConnections.id, { onDelete: "restrict" }),
    entityType: text("entity_type").notNull(),
    externalId: text("external_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payloadCiphertext: bytea("payload_ciphertext").notNull(),
    payloadNonce: bytea("payload_nonce").notNull(),
    keyVersion: text("key_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    processingStatus: rawRecordStatus("processing_status")
      .default("captured")
      .notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("raw_records_source_external_hash_run_unique").on(
      table.sourceConnectionId,
      table.externalId,
      table.payloadHash,
      table.syncRunId,
    ),
    index("raw_records_sync_run_idx").on(table.syncRunId),
    index("raw_records_retention_idx").on(
      table.processingStatus,
      table.capturedAt,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceConnectionId: uuid("source_connection_id")
      .notNull()
      .references(() => sourceConnections.id, { onDelete: "restrict" }),
    rawRecordId: uuid("raw_record_id").references(() => rawRecords.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    title: text("title").notNull(),
    companyName: text("company_name").notNull(),
    category: text("category").notNull(),
    city: text("city").notNull(),
    detailedLocation: text("detailed_location"),
    /** 完整 JD（内部运营详情视图；落地页白名单投影禁止输出，docs/03 §10）。由 wb.jobs.list 补全。 */
    jobDescription: text("job_description"),
    /**
     * 本地可操作状态（docs/04 §6，2026-08-13 决策）：
     * - `actionable`：账号自身作用域（wb.jobs.list），可创建匹配任务；
     * - `not_in_access_scope`：上游仍沉睡但不在账号可操作集（不是"已关闭"，只是当前数据源下不可操作）；
     * - `match_unavailable`：在作用域但 match_candidates 返回权限边界（未来匹配工作流写入）；
     * - `source_incomplete`：数据源不完整（未来 JD/详情缺失时标记）。
     * 沉睡巡检视图只展示 actionable。
     */
    operabilityStatus: text("operability_status"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    status: text("status").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    daysWithoutRecommendation: integer("days_without_recommendation").notNull(),
    validRecommendationCount: integer("valid_recommendation_count"),
    eligibilityEvidence: jsonb("eligibility_evidence")
      .$type<Record<string, string>>()
      .notNull(),
    portalUrl: text("portal_url").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("jobs_source_connection_id_external_id_unique").on(
      table.sourceConnectionId,
      table.externalId,
    ),
    index("jobs_under_served_idx").on(
      table.status,
      table.daysWithoutRecommendation,
    ),
    index("jobs_raw_record_idx").on(table.rawRecordId),
  ],
);

export const asyncTaskStatus = pgEnum("async_task_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead",
]);

export const asyncTasks = pgTable(
  "async_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: asyncTaskStatus("status").default("pending").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("async_tasks_idempotency_key_unique").on(table.idempotencyKey),
    index("async_tasks_due_idx").on(table.status, table.scheduledAt),
  ],
);

/** M2 本地匹配：职位要求（本地硬过滤/加权评分的职位输入，docs/03 §8；真实来源 JD 派生或 Web 采集）。 */
export const jobRequirements = pgTable(
  "job_requirements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    /** 硬过滤/加权评分所需技能清单。 */
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    seniority: text("seniority"),
    education: text("education"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    /** 其他不可妥协约束（如学历门槛/证书/语言）。 */
    constraints: jsonb("constraints").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("job_requirements_job_id_unique").on(table.jobId),
  ],
);

/** M2 匹配：评分规则版本（本地版本化、可复算；ADR-005 主评分路径，供应方 match_candidates 仅外部对照）。 */
export const matchRules = pgTable(
  "match_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 规则版本号：matches.rule_version 引用；版本不变则同输入可复算。 */
    version: integer("version").notNull(),
    /** 7 维权重：技能/行业/职级/经历/地点/薪资/活跃度（docs/01 §1.3）。 */
    weights: jsonb("weights").$type<Record<string, number>>().notNull().default({}),
    /** 分带阈值 {high:85, medium:75} + 硬过滤阈值（如 education_min）。 */
    thresholds: jsonb("thresholds").$type<Record<string, number | string>>().notNull(),
    activeAt: timestamp("active_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("match_rules_version_unique").on(table.version)],
);

/** M2 匹配：候选人（打码名 + 摘要，无联系方式——docs/06）。 */
export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    summary: text("summary"),
    /** 触达许可：unknown → permitted → opted_out（M3 写入；docs/03 §9）。 */
    consentStatus: text("consent_status").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("candidates_external_id_unique").on(table.externalId)],
);

/** M2 匹配：候选人画像（本地评分输入：技能/经历/地点/学历/职级/行业/薪资/活跃度，docs/03 §8）。 */
export const candidateProfiles = pgTable(
  "candidate_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "restrict" }),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    experienceYears: integer("experience_years"),
    location: text("location"),
    education: text("education"),
    seniority: text("seniority"),
    industry: text("industry"),
    expectedSalaryMin: integer("expected_salary_min"),
    expectedSalaryMax: integer("expected_salary_max"),
    /** 活跃度：画像/简历最近更新时间（越近越高分）。 */
    activityUpdatedAt: timestamp("activity_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("candidate_profiles_candidate_id_unique").on(table.candidateId),
  ],
);

/** M2 匹配：职位—候选人匹配结果（**本地评分是权威分**；供应方 match_candidates 仅存 external_* 外部对照）。 */
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "restrict" }),
    /** 本地加权总分（0-100，可复算）。 */
    score: integer("score"),
    /** 本地分带：high(≥85) / medium(75-84) / low(0-74)。 */
    band: text("band"),
    /** 审核状态：generated → approved/rejected（docs/03 §9）。 */
    status: text("status").notNull().default("generated"),
    ruleVersion: integer("rule_version").notNull(),
    /** 规范化输入哈希（同规则版本同输入可复算，docs/01 §1.3）。 */
    inputHash: text("input_hash"),
    /** 本地计算状态。 */
    scoreStatus: text("score_status").notNull().default("local_computed"),
    /** 供应方 match_candidates 外部对照（非权威分）。 */
    externalScore: integer("external_score"),
    externalTier: text("external_tier"),
    externalScoreStatus: text("external_score_status"),
    /** 匹配证据（命中项）。 */
    evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
    /** 缺失项。 */
    missing: jsonb("missing").$type<string[]>().notNull().default([]),
    /** 风险提示。 */
    risk: jsonb("risk").$type<string[]>().notNull().default([]),
    /** 两阶段匹配追溯（M3，迁移 0008；本切片不消费，LLM/汇总切片使用）：投影/过滤/运行引用。 */
    jobProjectionId: uuid("job_projection_id").references(
      () => jobMatchProjections.id,
      { onDelete: "set null" },
    ),
    candidateProjectionId: uuid("candidate_projection_id").references(
      () => candidateMatchProjections.id,
      { onDelete: "set null" },
    ),
    filterResultId: uuid("filter_result_id").references(
      () => matchFilterResults.id,
      { onDelete: "set null" },
    ),
    llmScoreRunId: uuid("llm_score_run_id").references(
      () => llmScoreRuns.id,
      { onDelete: "set null" },
    ),
    aggregationRuleVersion: text("aggregation_rule_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("matches_job_candidate_rule_unique").on(
      table.jobId,
      table.candidateId,
      table.ruleVersion,
    ),
    index("matches_job_idx").on(table.jobId),
    index("matches_status_idx").on(table.status),
  ],
);

/** M2 匹配：维度分与证据/风险（本地评分各维度，docs/01 §1.3）。 */
export const matchDimensions = pgTable(
  "match_dimensions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    score: integer("score"),
    evidence: text("evidence"),
    risk: text("risk"),
    /** 两阶段扩展（迁移 0008，本切片不消费）：LLM 维度可评估性/置信度/运行追溯。 */
    assessable: boolean("assessable"),
    confidence: doublePrecision("confidence"),
    llmScoreRunId: uuid("llm_score_run_id").references(
      () => llmScoreRuns.id,
      { onDelete: "set null" },
    ),
    outputHash: text("output_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("match_dimensions_match_idx").on(table.matchId)],
);

/** M3 两阶段匹配：职位要求投影（不可变、版本化，docs/03 §7.4、docs/10 §3）。 */
export const jobMatchProjections = pgTable(
  "job_match_projections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    schemaVersion: text("schema_version").notNull(),
    generatorType: text("generator_type").notNull(),
    generatorVersion: text("generator_version").notNull(),
    /** 规范化源输入 SHA-256（64 位 hex，同版本同输入可复算；源内容变化 → 新投影不覆盖）。 */
    inputHash: text("input_hash").notNull(),
    sourceSnapshotRefs: jsonb("source_snapshot_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    /** ≤150 中文字符，不含公司名/联系方式（docs/10 §3.1）。 */
    displaySummary: text("display_summary").notNull(),
    /** hard_requirements + scoring_context + extraction_warnings（docs/10 §3）。 */
    requirements: jsonb("requirements").$type<Record<string, unknown>>().notNull(),
    /** consumable（Schema 通过）/ rejected（不消费）。 */
    status: text("status").notNull().default("consumable"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("job_match_projections_immutable_unique").on(
      table.jobId,
      table.schemaVersion,
      table.generatorVersion,
      table.inputHash,
    ),
    index("job_match_projections_job_idx").on(table.jobId),
  ],
);

/** M3 两阶段匹配：候选人脱敏匹配投影（不可变、版本化，docs/03 §7.4、docs/10 §4）。 */
export const candidateMatchProjections = pgTable(
  "candidate_match_projections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "restrict" }),
    schemaVersion: text("schema_version").notNull(),
    generatorVersion: text("generator_version").notNull(),
    redactionVersion: text("redaction_version").notNull(),
    /** 规范化源输入 SHA-256（64 位 hex）。 */
    inputHash: text("input_hash").notNull(),
    sourceSnapshotRefs: jsonb("source_snapshot_refs")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    /** ≤150 中文字符，不含联系方式/直接身份标识（docs/10 §4）。 */
    displaySummary: text("display_summary").notNull(),
    /** 脱敏结构化画像（skills/experience_years/city/education/…）。 */
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull(),
    /** 脱敏简历详情（应用层 AES-256-GCM 加密，docs/03 §7.4、docs/10 §4）。 */
    redactedDetailCiphertext: bytea("redacted_detail_ciphertext").notNull(),
    redactedDetailNonce: bytea("redacted_detail_nonce").notNull(),
    keyVersion: text("key_version").notNull(),
    redactedDetailHash: text("redacted_detail_hash").notNull(),
    /** removed/generalized categories + residual_pii_scan（must be "passed"）。 */
    redactionReport: jsonb("redaction_report")
      .$type<Record<string, unknown>>()
      .notNull(),
    /** consumable（PII 扫描通过）/ rejected（残留 PII，LLM 拒绝）。 */
    status: text("status").notNull().default("consumable"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("candidate_match_projections_immutable_unique").on(
      table.candidateId,
      table.schemaVersion,
      table.generatorVersion,
      table.redactionVersion,
      table.inputHash,
    ),
    index("candidate_match_projections_candidate_idx").on(table.candidateId),
  ],
);

/** M3 两阶段匹配：第一阶段确定性硬过滤结果（不可变，docs/03 §7.4、docs/10 §5）。 */
export const matchFilterResults = pgTable(
  "match_filter_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobProjectionId: uuid("job_projection_id")
      .notNull()
      .references(() => jobMatchProjections.id, { onDelete: "restrict" }),
    candidateProjectionId: uuid("candidate_projection_id")
      .notNull()
      .references(() => candidateMatchProjections.id, { onDelete: "restrict" }),
    filterRuleVersion: text("filter_rule_version").notNull(),
    /** 职位投影 hash + 候选人投影 hash + 规则版本 组合 SHA-256。 */
    combinedInputHash: text("combined_input_hash").notNull(),
    passed: boolean("passed").notNull(),
    /** [{code, jobValue, candidateValue, explanation}]（docs/10 §5）。 */
    reasonCodes: jsonb("reason_codes")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("match_filter_results_immutable_unique").on(
      table.jobProjectionId,
      table.candidateProjectionId,
      table.filterRuleVersion,
    ),
    index("match_filter_results_job_proj_idx").on(table.jobProjectionId),
    index("match_filter_results_cand_proj_idx").on(table.candidateProjectionId),
  ],
);

/** M3 两阶段匹配：LLM 脱敏详情维度评分运行（docs/03 §7.4、docs/10 §6；本切片建表不消费）。 */
export const llmScoreRuns = pgTable(
  "llm_score_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    filterResultId: uuid("filter_result_id")
      .notNull()
      .references(() => matchFilterResults.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull().default(1),
    /** pending/running/succeeded/failed（docs/10 §6.3）。 */
    status: text("status").notNull().default("pending"),
    adapterId: text("adapter_id"),
    adapterVersion: text("adapter_version"),
    modelId: text("model_id"),
    modelRevision: text("model_revision"),
    promptVersion: text("prompt_version"),
    schemaVersion: text("schema_version"),
    /** 实际发给适配器的规范化脱敏请求 SHA-256。 */
    requestHash: text("request_hash"),
    /** 加密结构化输出（docs/10 §6.1）。 */
    responseCiphertext: bytea("response_ciphertext"),
    responseNonce: bytea("response_nonce"),
    keyVersion: text("key_version"),
    outputHash: text("output_hash"),
    /** 白名单参数 jsonb。 */
    parameters: jsonb("parameters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** 失败只存机器码（LLM_TIMEOUT/LLM_RATE_LIMITED/…），不存供应商错误正文。 */
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("llm_score_runs_filter_result_idx").on(table.filterResultId),
    index("llm_score_runs_status_idx").on(table.status),
  ],
);
