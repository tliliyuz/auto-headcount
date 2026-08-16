export const CSDN_EXTRACTION_TOOL: "csdn_run_extraction_contract";
export const CSDN_CONNECTION_STATUS_TOOL: "csdn_get_browser_connection_status";
export const LIEBIDE_JOB_DETAIL_CONTRACT_ID: "liebide-job-detail-v1";
export const LIEBIDE_JOB_DETAIL_CONTRACT_VERSION: 1;
export const LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID: "liebide-job-detail-v2";
export const LIEBIDE_JOB_DETAIL_V2_CONTRACT_VERSION: 2;
export const LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID: "liebide-filtered-job-list-v2";
export const LIEBIDE_FILTERED_JOB_LIST_CONTRACT_VERSION: 2;
export const LIEBIDE_PLATFORM_ORIGIN: "https://portal.liebide.com";

export class BrowserCollectionContractError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export interface JobDetailExtractionRoute {
  userId: string;
  deviceId: string;
  browserSessionId?: string;
  expectedExternalId: string;
  expectedTitle?: string;
}

export interface JobDetailExtractionArguments extends JobDetailExtractionRoute {
  contractId: typeof LIEBIDE_JOB_DETAIL_CONTRACT_ID | typeof LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID;
}

export interface ParsedJobDetailExtraction {
  contractId: string;
  contractVersion: number;
  sourceOrigin: string;
  capturedAt: string;
  contentHash: string;
  externalId: string;
  title: string;
  status: string;
  city: string;
  salaryMin: number | null;
  salaryMax: number | null;
  jobDescription: string | null;
  /** v2 专用：页面加载成功但供应方无 JD 的显式信号；v1 回执不出现。 */
  jobDescriptionMissing?: boolean;
  publishedAt: string | null;
  validRecommendationCount: number | null;
}

export function buildJobDetailExtractionArguments(
  input: JobDetailExtractionRoute,
  contractId?: string,
): JobDetailExtractionArguments;
export function buildBrowserConnectionStatusArguments(
  input: JobDetailExtractionRoute,
  contractId?: string,
): JobDetailExtractionArguments;
export function parseBrowserConnectionStatusResult(
  input: unknown,
): Record<string, unknown>;
export function parseJobDetailExtractionResult(
  input: unknown,
): ParsedJobDetailExtraction;
export interface FilteredJobListRoute {
  userId: string;
  deviceId: string;
  browserSessionId?: string;
  batchSize: number;
  maxPages: number;
  startPage?: number;
  startOffset?: number;
  contractId?: typeof LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID;
}
export function buildFilteredJobListExtractionArguments(input: FilteredJobListRoute): FilteredJobListRoute & { contractId: typeof LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID };
export function buildFilteredJobListConnectionStatusArguments(input: FilteredJobListRoute): Record<string, unknown>;
export function parseFilteredJobListExtractionResult(input: unknown, limits: { batchSize: number; maxPages: number }): Record<string, unknown>;
