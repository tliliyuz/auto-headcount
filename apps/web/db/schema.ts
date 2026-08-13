import {
  boolean,
  customType,
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
