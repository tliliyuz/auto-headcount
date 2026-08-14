import type {
  JobDetailExtractionRoute,
  ParsedJobDetailExtraction,
  FilteredJobListRoute,
} from "./browser-collection-contract.mjs";

export class BrowserRelayError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export function createCsdnBrowserRelayClient(options: {
  requestUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): {
  getConnectionStatus(
    input: JobDetailExtractionRoute | FilteredJobListRoute,
  ): Promise<Record<string, unknown>>;
  extractJobDetail(
    input: JobDetailExtractionRoute,
  ): Promise<ParsedJobDetailExtraction>;
  discoverFilteredJobs(input: FilteredJobListRoute): Promise<Record<string, unknown>>;
};
