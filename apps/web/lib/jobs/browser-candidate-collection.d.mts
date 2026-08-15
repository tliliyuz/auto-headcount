export class BrowserCandidateCollectionError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export interface BrowserCandidateCollectTaskPayload {
  collectionBatchId?: string;
  collectionItemId?: string;
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: "liebide-candidate-detail-v1";
  externalId: string;
  expectedTitle?: string;
}

export interface BrowserCandidateBatchDiscoverTaskPayload {
  batchId: string;
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: "liebide-talent-pool-list-v1";
  batchSize: number;
  maxPages: number;
  startPage?: number;
  startOffset?: number;
}

export function parseBrowserCandidateCollectTaskPayload(
  input: unknown,
): BrowserCandidateCollectTaskPayload;

export function parseBrowserCandidateBatchDiscoverTaskPayload(
  input: unknown,
): BrowserCandidateBatchDiscoverTaskPayload;

export function mapCandidateRecordToEntities(
  record: Record<string, unknown>,
): { candidate: Record<string, unknown>; profile: Record<string, unknown> };

export function runBrowserCandidateCollection(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runBrowserCandidateBatchDiscovery(options: Record<string, unknown>): Promise<Record<string, unknown>>;
