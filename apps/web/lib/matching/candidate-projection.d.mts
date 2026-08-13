export const CANDIDATE_PROJECTION_SCHEMA: "candidate-match-projection/v1";
export const PII_DETECTED_ERROR: "MATCH_PROJECTION_PII_DETECTED";

export type CandidateProjectionInput = {
  candidate: {
    id: string;
    external_id?: string | null;
    externalId?: string | null;
    display_name?: string | null;
    displayName?: string | null;
  };
  profile: {
    skills?: string[];
    experienceYears?: number | null;
    experience_years?: number | null;
    location?: string | null;
    education?: string | null;
    seniority?: string | null;
    industry?: string | null;
    expectedSalaryMin?: number | null;
    expectedSalaryMax?: number | null;
    expected_salary_min?: number | null;
    expected_salary_max?: number | null;
    activityUpdatedAt?: string | Date | null;
    activity_updated_at?: string | Date | null;
    certificates?: string[];
  };
  redactedDetail?: {
    career_history?: string[];
    project_highlights?: string[];
  };
  sourceSnapshotRefs?: Array<Record<string, unknown>>;
  generatorVersion: string;
  redactionVersion: string;
  generatedAt: string;
  projectionId?: string;
};

export type CandidateProjectionResult =
  | { ok: true; projection: Record<string, unknown>; inputHash: string }
  | { ok: false; errorCode: string; reason?: string; errors?: unknown[] };

export function generateCandidateProjection(
  input: CandidateProjectionInput,
): Promise<CandidateProjectionResult>;

export function scanResidualPii(input: {
  profile?: Record<string, unknown>;
  redactedDetail?: { career_history?: string[]; project_highlights?: string[] };
}): { detected: string[] };
