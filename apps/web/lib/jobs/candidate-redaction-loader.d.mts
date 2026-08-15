import type postgres from "postgres";

type SqlClient = postgres.Sql;

export type CandidateRedactedDetails = {
  career_history: string[];
  project_highlights: string[];
};

export const REDACTED_COMPANY_PLACEHOLDER: "某公司";

export function buildRedactedCareerHistory(
  workExperiences?: Array<{ company?: string | null; title?: string | null }>,
  options?: { maxItems?: number },
): string[];

export function loadCandidateRedactedDetails(
  sql: SqlClient,
  input: { encryption: { key: string; keyVersion: string } },
): Promise<Map<string, CandidateRedactedDetails>>;
