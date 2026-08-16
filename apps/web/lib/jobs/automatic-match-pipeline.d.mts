import type postgres from "postgres";
export const MATCH_PIPELINE_TASK_KIND: string;
export const LLM_ERROR_CODE_WHITELIST: readonly string[];
export function classifyScoreError(error: unknown): string;
export function resolveDetailScoringAdapter(env: Record<string, string | undefined>, injectedAdapter?: unknown): unknown;
export function selectBudgetedCandidates(items: Array<Record<string, unknown> & { jobId: string; filterResultId: string; preRank: number }>, limits: { maxCandidatesPerJob: number; globalBudget: number }): Array<Record<string, unknown>>;
export function runAutomaticMatchPipeline(input: { sql: postgres.Sql; env: Record<string, string | undefined>; adapter?: unknown; maxCandidatesPerJob?: number; globalBudget?: number; maxAttempts?: number; now?: () => Date }): Promise<Record<string, unknown>>;
