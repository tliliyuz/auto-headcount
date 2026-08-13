export type JobRequirementsInput = {
  skills?: string[];
  seniority?: string | null;
  education?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  location?: string | null;
  industry?: string | null;
  min_experience_years?: number;
};

export type CandidateProfileInput = {
  skills?: string[];
  experienceYears?: number | null;
  location?: string | null;
  education?: string | null;
  seniority?: string | null;
  industry?: string | null;
  expectedSalaryMin?: number | null;
  expectedSalaryMax?: number | null;
  activityUpdatedAt?: string | Date | null;
};

export type DimensionScore = {
  dimension: string;
  score: number;
  evidence: string | null;
  risk: string | null;
};

export type ScoreResult =
  | {
      passed: false;
      totalScore: null;
      band: null;
      dimensions: [];
      evidence: [];
      missing: string[];
      risk: [];
      inputHash: string;
    }
  | {
      passed: true;
      totalScore: number;
      band: string;
      dimensions: DimensionScore[];
      evidence: string[];
      missing: string[];
      risk: string[];
      inputHash: string;
    };

export const DEFAULT_WEIGHTS: Record<string, number>;
export const DEFAULT_THRESHOLDS: Record<string, number>;

export function hardFilter(input: {
  jobRequirements?: JobRequirementsInput;
  candidateProfile?: CandidateProfileInput;
}): { passed: boolean; missing: string[] };

export function dimensionScores(input: {
  jobRequirements?: JobRequirementsInput;
  candidateProfile?: CandidateProfileInput;
}): DimensionScore[];

export function scoreMatch(input: {
  jobRequirements?: JobRequirementsInput;
  candidateProfile?: CandidateProfileInput;
  weights?: Record<string, number>;
  thresholds?: Record<string, number>;
  ruleVersion?: number;
}): ScoreResult;

export function computeInputHash(input: {
  jobRequirements?: JobRequirementsInput;
  candidateProfile?: CandidateProfileInput;
  weights?: Record<string, number>;
  thresholds?: Record<string, number>;
  ruleVersion?: number;
}): string;
