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
  findKnownExternalIds(input: { sourceConnectionId: string }): Promise<Array<{ externalId: string; title: string }>>;
  persistDiscovery(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listBatches(input?: {
    page?: number;
    pageSize?: number;
  }): Promise<{
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    list: Array<{
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
    }>;
  }>;
};
export function updateBrowserCollectionItemOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
export function updateBrowserCollectionBatchDiscoveryOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
