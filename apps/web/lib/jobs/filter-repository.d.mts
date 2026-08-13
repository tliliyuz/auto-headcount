import type postgres from "postgres";

type SqlClient = postgres.Sql;

export function insertMatchFilterResult(
  sql: SqlClient,
  input: {
    jobProjectionId: string;
    candidateProjectionId: string;
    filterRuleVersion: string;
    combinedInputHash: string;
    passed: boolean;
    reasonCodes: Array<Record<string, unknown>>;
  },
): Promise<{ id: string; created: boolean }>;
