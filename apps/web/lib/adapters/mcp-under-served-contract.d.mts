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
  code: "MCP_CONTRACT_INVALID" | "MCP_UPSTREAM_ERROR";
}

export function parseUnderServedJobsResult(result: unknown): UnderServedJobPage;

export function selectEligibleUnderServedJobs(
  page: UnderServedJobPage,
): UnderServedJobSourceRecord[];

export function selectEligibleUnderServedPairs(
  page: UnderServedJobPage,
): UnderServedJobPair[];
