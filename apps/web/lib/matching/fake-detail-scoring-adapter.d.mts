export const FAKE_DETAIL_SCORING_METADATA: Readonly<Record<string, string>>;
export function createFakeDetailScoringAdapter(): {
  metadata: Readonly<Record<string, string>>;
  score(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
