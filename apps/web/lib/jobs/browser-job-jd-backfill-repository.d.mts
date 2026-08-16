import type postgres from "postgres";

import type { ParsedJobDetailExtraction } from "../adapters/csdn-browser/browser-collection-contract.mjs";

export interface BrowserJobJdBackfillRepository {
  sourceExists(sourceConnectionId: string): Promise<boolean>;
  persistFilled(input: {
    sourceConnectionId: string;
    contractId: string;
    jobId: string;
    externalId: string;
    record: ParsedJobDetailExtraction;
  }): Promise<{
    syncRunId: string;
    rawRecordId: string;
    ledgerId: string;
    matched: number;
  }>;
  persistNoProviderJd(input: {
    sourceConnectionId: string;
    contractId: string;
    jobId: string;
    externalId: string;
    record: ParsedJobDetailExtraction;
  }): Promise<{
    syncRunId: string;
    rawRecordId: string;
    ledgerId: string;
    matched: number;
  }>;
  persistFailed(input: {
    sourceConnectionId: string;
    contractId: string;
    jobId: string;
    externalId: string;
    errorCode: string;
  }): Promise<{ syncRunId: string; ledgerId: string }>;
}

export function createBrowserJobJdBackfillRepository(
  sql: postgres.Sql,
  options: { encryption: { key: string; keyVersion: string } },
): BrowserJobJdBackfillRepository;

export interface JobJdBackfillRow {
  id: string;
  jobId: string;
  sourceConnectionId: string;
  externalId: string;
  jobTitle: string | null;
  contractId: string;
  outcome: "filled" | "no_provider_jd" | "failed";
  jdLength: number;
  contentHash: string | null;
  errorCode: string | null;
  createdAt: Date;
}

export function listJobJdBackfills(
  sql: postgres.Sql,
  input?: {
    outcome?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<{
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  list: JobJdBackfillRow[];
}>;
