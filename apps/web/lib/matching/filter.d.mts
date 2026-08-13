export const FILTER_REASON_CODES: Record<
  | "LOCATION_MISMATCH"
  | "REQUIRED_SKILL_MISSING"
  | "EXPERIENCE_BELOW_MINIMUM"
  | "EDUCATION_BELOW_MINIMUM"
  | "CERTIFICATE_MISSING"
  | "SALARY_NO_OVERLAP"
  | "REQUIRED_FIELD_MISSING",
  string
>;

export type FilterReasonCode = {
  code: string;
  jobValue: string;
  candidateValue: string;
  explanation: string;
};

export type HardFilterResult = {
  passed: boolean;
  reasonCodes: FilterReasonCode[];
  combinedInputHash: string;
};

export function hardFilter(input: {
  jobProjection: Record<string, unknown>;
  candidateProjection: Record<string, unknown>;
  filterRuleVersion?: string;
}): HardFilterResult;
