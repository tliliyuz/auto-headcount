export const AGGREGATION_RULE_VERSION: string;
export const DETAIL_SCORE_WEIGHTS: Readonly<Record<string, number>>;
export function aggregateDetailScore(output: Record<string, unknown>): Promise<Record<string, unknown>>;
export function deriveMatchRuleVersion(versionBundle: Record<string, unknown>): Promise<number>;
export function hashCanonical(value: unknown): Promise<string>;
