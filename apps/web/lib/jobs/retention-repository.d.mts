import type postgres from "postgres";

type SqlClient = postgres.Sql;

export type AuditEntry = {
  actorType: string;
  actorId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

export type RetentionRepository = {
  deleteExpiredRawRecords(input: {
    successCutoff: Date;
    exceptionCutoff: Date;
  }): Promise<number>;
  deleteClosedJobs(input: { cutoff: Date }): Promise<number>;
  deleteExpiredSessions(input: { now: Date }): Promise<number>;
  deleteExpiredAuditLogs(input: { cutoff: Date }): Promise<number>;
  insertAudit(entry: AuditEntry): Promise<void>;
};

export function createRetentionRepository(sql: SqlClient): RetentionRepository;
