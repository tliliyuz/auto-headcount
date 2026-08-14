export class BrowserJobCollectionError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export interface BrowserJobCollectTaskPayload {
  collectionBatchId?: string;
  collectionItemId?: string;
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: "liebide-job-detail-v1";
  externalId: string;
  expectedTitle?: string;
}

export interface BrowserJobBatchDiscoverTaskPayload {
  batchId: string;
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: "liebide-filtered-job-list-v2";
  batchSize: number;
  maxPages: number;
  startPage?: number;
  startOffset?: number;
}

export function parseBrowserJobCollectTaskPayload(
  input: unknown,
): BrowserJobCollectTaskPayload;

export function evaluateBrowserJobEligibility(
  record: Record<string, unknown>,
  now: Date,
): { eligible: boolean; ageDays: number | null; reason: string | null };

export function runBrowserJobCollection(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function parseBrowserJobBatchDiscoverTaskPayload(input: unknown): BrowserJobBatchDiscoverTaskPayload;
export function runBrowserJobBatchDiscovery(options: Record<string, unknown>): Promise<Record<string, unknown>>;
