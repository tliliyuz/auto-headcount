export function createBrowserJobBatchRepository(sql: unknown): {
  createAndEnqueue(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  sourceExists(sourceConnectionId: string): Promise<boolean>;
  persistDiscovery(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
export function updateBrowserCollectionItemOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
export function updateBrowserCollectionBatchDiscoveryOutcome(sql: unknown, payload: Record<string, unknown>, outcome: Record<string, unknown>, decision: string, now: Date): Promise<void>;
