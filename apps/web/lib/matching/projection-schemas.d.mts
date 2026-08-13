export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: unknown[] };

export function validateJobRequirementProjection(
  document: Record<string, unknown>,
): Promise<SchemaValidationResult>;

export function validateCandidateMatchProjection(
  document: Record<string, unknown>,
): Promise<SchemaValidationResult>;

export function validateLlmDetailScore(
  document: Record<string, unknown>,
): Promise<SchemaValidationResult>;
