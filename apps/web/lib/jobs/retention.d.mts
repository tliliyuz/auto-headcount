import type postgres from "postgres";
import type { RetentionRepository } from "./retention-repository.mjs";

type SqlClient = postgres.Sql;

export type RetentionTtl = {
  rawSuccessDays: number;
  rawExceptionDays: number;
  jobClosedDays: number;
  auditDays: number;
};

export type RetentionCounts = {
  rawRecordsDeleted: number;
  jobsDeleted: number;
  sessionsDeleted: number;
  auditLogsDeleted: number;
};

export type RetentionOutcome =
  | { status: "succeeded"; counts: RetentionCounts }
  | { status: "failed"; errorCode: string; counts: RetentionCounts };

export function runRetention(input: {
  sql?: SqlClient;
  ttl?: Partial<RetentionTtl>;
  now?: Date;
  requestId?: string | null;
  repo?: RetentionRepository;
}): Promise<RetentionOutcome>;
