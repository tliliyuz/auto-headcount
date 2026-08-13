export class BrowserJobCollectionError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export interface BrowserJobCollectTaskPayload {
  sourceConnectionId: string;
  userId: string;
  deviceId: string;
  contractId: "liebide-job-detail-v1";
  externalId: string;
}

export function parseBrowserJobCollectTaskPayload(
  input: unknown,
): BrowserJobCollectTaskPayload;

export function evaluateBrowserJobEligibility(
  record: Record<string, unknown>,
  now: Date,
): { eligible: boolean; ageDays: number | null; reason: string | null };

export function runBrowserJobCollection(options: Record<string, unknown>): Promise<Record<string, unknown>>;
