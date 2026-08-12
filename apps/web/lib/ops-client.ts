/**
 * 客户端侧业务只读 API 封装（纯 fetch，无服务端依赖，供 "use client" 组件使用）。
 * 契约见 docs/09-api-contract.md §2.2；复用 auth-client 的 AuthResult 判别结果类型，
 * 401/403 由页面统一处理（退回登录 / 显示无权限）。
 */

import { type AuthResult, request } from "./auth-client";

export type Paged<T> = {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  list: T[];
};

export type DormantJob = {
  id: string;
  externalId: string;
  mappingVersion: string;
  title: string;
  companyName: string;
  category: string;
  city: string;
  detailedLocation: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  status: string;
  ageDays: number;
  recommendationCount: number;
  sourceConnectionId: string;
  rawRecordId: string | null;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceView = {
  id: string;
  provider: string;
  environment: string;
  status: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
  lastRunSyncType: string | null;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunErrorCode: string | null;
  lastRunStats: Record<string, number> | null;
};

export type SyncRunView = {
  id: string;
  sourceConnectionId: string;
  sourceDisplayName: string;
  sourceProvider: string;
  syncType: string;
  status: string;
  stats: Record<string, number>;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export function fetchDormantJobs(input?: {
  category?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<DormantJob>>> {
  return request<Paged<DormantJob>>(
    withQuery("/api/jobs/under-served", {
      category: input?.category,
      q: input?.q,
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}

export function fetchSources(input?: {
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<SourceView>>> {
  return request<Paged<SourceView>>(
    withQuery("/api/sources", {
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}

export function fetchSyncRuns(input?: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<SyncRunView>>> {
  return request<Paged<SyncRunView>>(
    withQuery("/api/sync-runs", {
      status: input?.status,
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}
