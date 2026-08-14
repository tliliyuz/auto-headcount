import type postgres from "postgres";
export function listMatchExceptions(sql: postgres.Sql, input?: { type?: "all" | "filter" | "scoring"; page?: number; pageSize?: number }): Promise<Record<string, unknown>>;
