export type UnderServedJobSourceRecord = {
  externalId: string;
  title: string;
  companyName: string;
  ownerExternalId: string;
  ownerName: string;
  ageDays: number;
  lastRecommendationAt: string | null;
  category: string;
  city: string;
  salaryMin: number | null;
  salaryMax: number | null;
  portalUrl: string;
  sourceCreatedAt: string | null;
  eligibilityEvidence: {
    activeStatus: "provider_filter";
    zeroRecommendations: "provider_filter";
    age: "days_without_rec";
  };
};

export type UnderServedJobPage = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  jobs: UnderServedJobSourceRecord[];
  rawItems: unknown[];
};

export type UnderServedJobPair = {
  job: UnderServedJobSourceRecord;
  rawItem: unknown;
  index: number;
};

export class McpContractError extends Error {
  code:
    | "MCP_CONTRACT_INVALID"
    | "MCP_UPSTREAM_ERROR"
    | "MCP_PERMISSION_BOUNDARY";
}

export function parseUnderServedJobsResult(result: unknown): UnderServedJobPage;

export function selectEligibleUnderServedJobs(
  page: UnderServedJobPage,
): UnderServedJobSourceRecord[];

export function selectEligibleUnderServedPairs(
  page: UnderServedJobPage,
): UnderServedJobPair[];

export type JobsListItem = {
  externalId: string;
  jobDescription: string | null;
};

export type JobsListPage = {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  jobs: JobsListItem[];
};

export function parseJobsListResult(result: unknown): JobsListPage;

export type JobsGetDetail = {
  externalId: string;
  jobDescription: string | null;
};

/** `wb.jobs.get(job_id)`：Data 为单职位对象（非 list 包裹）。 */
export function parseJobsGetResult(result: unknown): JobsGetDetail;

export type MatchDimensionScore = {
  dimension: string;
  score: number | null;
};

export type MatchCandidateView = {
  candidateId: string;
  isOwn: boolean;
  ownerId: string | null;
  ownerName: string | null;
  /** cached / pending（LLM 打分中，正常态）/ failed。 */
  scoreStatus: string;
  totalScore: number | null;
  tier: string | null;
  /** 维度分：pending 时为 null，cached 时为 [{dimension, score}]。 */
  dimensionScores: MatchDimensionScore[] | null;
  /** 匹配证据（命中项）。 */
  matchHighlights: string[] | null;
  /** 缺失项。 */
  gapAnalysis: string[] | null;
  /** 风险提示。 */
  riskFlags: string[] | null;
  verificationSuggestions: string[] | null;
  jobSummary: string | null;
  candidate: {
    name: string | null;
    currentTitle: string | null;
    currentCompany: string | null;
    city: string | null;
    experienceYears: number | null;
    resumeSummary: string | null;
  } | null;
};

export type MatchCandidatesResult = {
  sourceId: string;
  sourceType: string;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  matches: MatchCandidateView[];
};

export function parseMatchCandidatesResult(
  result: unknown,
): MatchCandidatesResult;
