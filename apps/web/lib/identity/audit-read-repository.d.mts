import type postgres from "postgres";

export interface AuditLogRow {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  result: string;
  requestId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
}

export interface PagedAuditLogs {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: AuditLogRow[];
}

export declare function listAuditLogs(
  sql: postgres.Sql,
  input: {
    action?: string;
    actorType?: string;
    result?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<PagedAuditLogs>;
