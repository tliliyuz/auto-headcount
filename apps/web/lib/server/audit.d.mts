import type { AuditEntry } from "../identity/auth-repository.mjs";

export interface AuditPlanInput {
  requestId?: string | null;
  actor?: { id: string } | null;
  action: string;
  resourceType?: string | null;
  outcome: "success" | "denied" | "failure";
  metadataKeys?: string[];
  audit?: {
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  };
  ipAddress?: string | null;
}

export declare function pickMetadata(
  metadata: unknown,
  keys: string[],
): Record<string, unknown>;

export declare function planAudit(input: AuditPlanInput): AuditEntry | null;
