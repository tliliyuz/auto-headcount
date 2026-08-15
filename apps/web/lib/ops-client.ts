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
  /** 是否有完整 JD（`jobs.job_description` 非空）；用于列表「只看有详情」筛选与行内标记。 */
  hasDescription: boolean;
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

export type BrowserBatchView = {
  id: string;
  sourceConnectionId: string;
  batchSize: number;
  maxPages: number;
  status: string;
  discoveredCount: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  stopReason: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type CandidateBatchView = BrowserBatchView;

export type AuditLogView = {
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
};

export type MatchDimensionView = {
  dimension: string;
  score: number | null;
  evidence: string | null;
  risk: string | null;
  assessable: boolean | null;
  confidence: number | null;
  llmScoreRunId: string | null;
  outputHash: string | null;
};

export type MatchFilterReasonView = {
  code: string;
  jobValue: string;
  candidateValue: string;
  explanation: string;
};

export type MatchFilterResultView = {
  passed: boolean;
  reasonCodes: MatchFilterReasonView[];
};

export type MatchView = {
  id: string; jobId: string; jobTitle: string; jobExternalId: string;
  candidateId: string; candidateName: string; candidateSummary: string | null;
  score: number | null; band: string | null; status: string; scoreStatus: string;
  ruleVersion: number | null; inputHash: string | null;
  externalScore: number | null; externalTier: string | null; externalScoreStatus: string | null;
  evidence: string[]; missing: string[]; risk: string[];
  jobProjectionId: string | null; candidateProjectionId: string | null;
  filterResult: MatchFilterResultView | null;
  llmScoreRunId: string | null; aggregationRuleVersion: string | null;
  modelId: string | null; modelRevision: string | null; promptVersion: string | null;
  schemaVersion: string | null; outputHash: string | null;
  createdAt: string; updatedAt: string;
};

export type MatchDetailView = MatchView & { dimensions: MatchDimensionView[] };

export type MatchExceptionView = {
  id: string; type: "filter" | "scoring"; errorCode: string; status: string;
  retryable: boolean; jobId: string; jobTitle: string; candidateId: string;
  candidateName: string; createdAt: string;
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
  signal?: AbortSignal;
}): Promise<AuthResult<Paged<DormantJob>>> {
  return request<Paged<DormantJob>>(
    withQuery("/api/jobs/under-served", {
      category: input?.category,
      q: input?.q,
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET", signal: input?.signal },
  );
}

/** 职位详情 = 列表投影字段 + jobDescription（完整 JD，可空）。契约见 docs/09 §2.2。 */
export type JobDetail = DormantJob & {
  jobDescription: string | null;
};

export function fetchJobDetail(
  id: string,
  input?: { signal?: AbortSignal },
): Promise<AuthResult<JobDetail>> {
  return request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`, {
    method: "GET",
    signal: input?.signal,
  });
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

export function fetchBrowserBatches(input?: {
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<BrowserBatchView>>> {
  return request<Paged<BrowserBatchView>>(
    withQuery("/api/browser-batches", {
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}

export function fetchCandidateBatches(input?: {
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<CandidateBatchView>>> {
  return request<Paged<CandidateBatchView>>(
    withQuery("/api/candidate-batches", {
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}

export function fetchAuditLogs(input?: {
  action?: string;
  actorType?: string;
  result?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<AuthResult<Paged<AuditLogView>>> {
  return request<Paged<AuditLogView>>(
    withQuery("/api/audit-logs", {
      action: input?.action,
      actor_type: input?.actorType,
      result: input?.result,
      q: input?.q,
      page: input?.page,
      page_size: input?.pageSize,
    }),
    { method: "GET" },
  );
}

export function fetchMatches(input?: { status?: string; band?: string; page?: number; pageSize?: number; signal?: AbortSignal }): Promise<AuthResult<Paged<MatchView>>> {
  return request(withQuery("/api/matches", {
    status: input?.status, band: input?.band, page: input?.page, page_size: input?.pageSize,
  }), { method: "GET", signal: input?.signal });
}

export function fetchMatchDetail(id: string, input?: { signal?: AbortSignal }): Promise<AuthResult<MatchDetailView>> {
  return request(`/api/matches/${encodeURIComponent(id)}`, { method: "GET", signal: input?.signal });
}

export function reviewMatch(id: string, decision: "approve" | "reject"): Promise<AuthResult<{ id: string; status: string }>> {
  return request(`/api/matches/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ decision }) });
}

export function fetchMatchExceptions(input?: { type?: "all" | "filter" | "scoring"; page?: number; pageSize?: number; signal?: AbortSignal }): Promise<AuthResult<Paged<MatchExceptionView>>> {
  return request(withQuery("/api/match-exceptions", {
    type: input?.type, page: input?.page, page_size: input?.pageSize,
  }), { method: "GET", signal: input?.signal });
}

/** 手动触发沉睡职位同步（写路由）：入队 async_tasks 任务，调度 tick 认领执行，返回 202 + taskId。 */
export function triggerSync(): Promise<
  AuthResult<{
    accepted: boolean;
    taskId: string | null;
    /** 服务端去重拦截：同 kind 已有活跃任务时 true，taskId 为既有活跃任务 id。 */
    deduplicated?: boolean;
  }>
> {
  return request<{
    accepted: boolean;
    taskId: string | null;
    deduplicated?: boolean;
  }>("/api/sync/under-served", { method: "POST" });
}

export function triggerBrowserCollection(input: {
  sourceConnectionId: string;
  batchSize: number;
  maxPages: number;
}): Promise<AuthResult<{ accepted: boolean; batchId: string; taskId: string | null; deduplicated?: boolean }>> {
  return request("/api/browser-collections", {
    method: "POST",
    body: JSON.stringify({ ...input, contractId: "liebide-filtered-job-list-v2" }),
  });
}

export function triggerCandidateCollection(input: {
  sourceConnectionId: string;
  batchSize: number;
  maxPages: number;
}): Promise<AuthResult<{ accepted: boolean; batchId: string; taskId: string | null; deduplicated?: boolean }>> {
  return request("/api/candidate-collections", {
    method: "POST",
    body: JSON.stringify({ ...input, contractId: "liebide-talent-pool-list-v1" }),
  });
}
