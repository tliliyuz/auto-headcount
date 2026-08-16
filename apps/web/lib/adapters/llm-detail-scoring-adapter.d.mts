export const LLM_DETAIL_SCORE_DIMENSIONS: readonly [
  "skills",
  "industry",
  "seniority",
  "experience",
  "location",
  "salary",
  "activity",
];

export const LLM_DETAIL_SCORING_ADAPTER_ID: "llm-openai-compatible";
export const LLM_DETAIL_SCORING_SCHEMA_VERSION: "llm-detail-score/v1";
export const LLM_DETAIL_PROMPT_VERSION: "match-detail-prompt/v1";
export const MATCH_DETAIL_PROMPT_V1: Readonly<string>;

export class LlmDetailScoringError extends Error {
  code: string;
  status?: number;
  retryable: boolean;
}

export type LlmDetailScoringConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  temperature: number;
  maxOutputTokens: number;
};

export function loadLlmDetailScoringConfig(
  env?: Record<string, string | undefined>,
): LlmDetailScoringConfig;

export function createLlmDetailScoringAdapter(
  env?: Record<string, string | undefined>,
  options?: { fetchImpl?: typeof fetch },
): {
  metadata: Readonly<Record<string, string>>;
  score(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export function assertLlmDetailScoreSemantics(
  document: Record<string, unknown>,
): void;

export function normalizeRequestItemId(value: unknown): string;
