import type {
  JobDetailExtractionRoute,
  ParsedJobDetailExtraction,
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
  extractJobDetail(
    input: JobDetailExtractionRoute,
  ): Promise<ParsedJobDetailExtraction>;
};
