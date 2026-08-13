export const JOB_PROJECTION_SCHEMA: "job-requirement-projection/v1";

export type JobProjectionInput = {
  job: {
    id: string;
    title?: string | null;
    category?: string | null;
    city?: string | null;
    salary_min?: number | null;
    salary_max?: number | null;
  };
  requirements?: {
    skills?: string[];
    seniority?: string | null;
    education?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    constraints?: Record<string, unknown>;
  };
  jd?: string | null;
  sourceSnapshotRefs?: Array<Record<string, unknown>>;
  generatorType?: "rules" | "llm_extraction" | "human_reviewed";
  generatorVersion: string;
  generatedAt: string;
  projectionId?: string;
};

export type JobProjectionResult =
  | { ok: true; projection: Record<string, unknown>; inputHash: string }
  | { ok: false; errors: unknown[] };

export function generateJobProjection(
  input: JobProjectionInput,
): Promise<JobProjectionResult>;
