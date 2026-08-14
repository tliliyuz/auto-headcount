export function createBrowserJobBatchRepository(sql: unknown): {
  createAndEnqueue(input: {
    payload: {
      sourceConnectionId: string;
      userId: string;
      deviceId: string;
      contractId: string;
      batchSize: number;
      maxPages: number;
      startPage?: number;
      startOffset?: number;
    };
    scheduledAt: Date;
  }): Promise<{
    accepted: boolean;
    deduplicated: boolean;
    batchId: string;
    taskId: string | null;
  }>;
  sourceExists(sourceConnectionId: string): Promise<boolean>;
  persistDiscovery(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
export function updateBrowserCollectionItemOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
export function updateBrowserCollectionBatchDiscoveryOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
