import {
  BrowserCollectionContractError,
  CSDN_CONNECTION_STATUS_TOOL,
  CSDN_EXTRACTION_TOOL,
  LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID,
  LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID,
  LIEBIDE_JOB_DETAIL_CONTRACT_ID,
  LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID,
  LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID,
  buildBrowserConnectionStatusArguments,
  buildCandidateDetailConnectionStatusArguments,
  buildCandidateDetailExtractionArguments,
  buildFilteredJobListConnectionStatusArguments,
  buildFilteredJobListExtractionArguments,
  buildJobDetailExtractionArguments,
  buildTalentPoolListConnectionStatusArguments,
  buildTalentPoolListExtractionArguments,
  parseBrowserConnectionStatusResult,
  parseCandidateDetailExtractionResult,
  parseFilteredJobListExtractionResult,
  parseJobDetailExtractionResult,
  parseTalentPoolListExtractionResult,
} from "./browser-collection-contract.mjs";

/** 浏览器采集含新标签页编排（候选人详情），给足加载/提取时间。 */
const DEFAULT_TIMEOUT_MS = 60_000;

export class BrowserRelayError extends Error {
  constructor(message, code = "BROWSER_RELAY_UNAVAILABLE") {
    super(message);
    this.name = "BrowserRelayError";
    this.code = code;
  }
}

export function createCsdnBrowserRelayClient({
  requestUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const endpoint = parseRequestUrl(requestUrl);
  const localToolEndpoint = buildLocalToolUrl(endpoint);
  if (typeof token !== "string" || token.trim() === "") {
    throw new BrowserRelayError("browser relay token is required", "BROWSER_RELAY_CONFIG_INVALID");
  }
  if (typeof fetchImpl !== "function") {
    throw new BrowserRelayError("browser relay fetch implementation is invalid", "BROWSER_RELAY_CONFIG_INVALID");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new BrowserRelayError("browser relay timeout is invalid", "BROWSER_RELAY_CONFIG_INVALID");
  }

  return {
    async getConnectionStatus(input) {
      if (input.contractId === LIEBIDE_FILTERED_JOB_LIST_CONTRACT_ID) {
        return callRelayTool(
          CSDN_CONNECTION_STATUS_TOOL,
          buildFilteredJobListConnectionStatusArguments(stripContractId(input)),
          parseBrowserConnectionStatusResult,
          localToolEndpoint,
        );
      }
      if (input.contractId === LIEBIDE_TALENT_POOL_LIST_CONTRACT_ID) {
        return callRelayTool(
          CSDN_CONNECTION_STATUS_TOOL,
          buildTalentPoolListConnectionStatusArguments(stripContractId(input)),
          parseBrowserConnectionStatusResult,
          localToolEndpoint,
        );
      }
      if (input.contractId === LIEBIDE_CANDIDATE_DETAIL_CONTRACT_ID) {
        return callRelayTool(
          CSDN_CONNECTION_STATUS_TOOL,
          buildCandidateDetailConnectionStatusArguments(stripContractId(input)),
          parseBrowserConnectionStatusResult,
          localToolEndpoint,
        );
      }
      const effectiveContractId =
        input.contractId === LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID
          ? LIEBIDE_JOB_DETAIL_V2_CONTRACT_ID
          : LIEBIDE_JOB_DETAIL_CONTRACT_ID;
      return callRelayTool(
        CSDN_CONNECTION_STATUS_TOOL,
        buildBrowserConnectionStatusArguments(stripContractId(input), effectiveContractId),
        parseBrowserConnectionStatusResult,
        localToolEndpoint,
      );
    },
    async extractJobDetail(input, options = {}) {
      const contractId = options.contractId ?? LIEBIDE_JOB_DETAIL_CONTRACT_ID;
      return callRelayTool(CSDN_EXTRACTION_TOOL, buildJobDetailExtractionArguments(input, contractId), parseJobDetailExtractionResult);
    },
    async discoverFilteredJobs(input) {
      const args = buildFilteredJobListExtractionArguments(stripContractId(input));
      return callRelayTool(CSDN_EXTRACTION_TOOL, args, (result) => parseFilteredJobListExtractionResult(result, args));
    },
    async discoverTalentPool(input) {
      const args = buildTalentPoolListExtractionArguments(stripContractId(input));
      return callRelayTool(CSDN_EXTRACTION_TOOL, args, (result) => parseTalentPoolListExtractionResult(result, args));
    },
    async extractCandidateDetail(input) {
      return callRelayTool(CSDN_EXTRACTION_TOOL, buildCandidateDetailExtractionArguments(input), parseCandidateDetailExtractionResult);
    },
  };

  async function callRelayTool(tool, args, parseResult, targetUrl = endpoint) {
      let response;
      try {
        response = await fetchImpl(targetUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool,
            arguments: args,
            timeoutMs,
          }),
          signal: AbortSignal.timeout(timeoutMs + 1000),
        });
      } catch {
        throw new BrowserRelayError("browser relay request failed");
      }
      if (!response.ok) {
        throw new BrowserRelayError("browser relay returned an HTTP error");
      }

      let envelope;
      try {
        envelope = await response.json();
      } catch {
        throw new BrowserRelayError("browser relay returned an invalid response");
      }
      if (!isPlainObject(envelope) || envelope.ok !== true || !("result" in envelope)) {
        throw new BrowserRelayError("browser relay returned an invalid envelope");
      }
      try {
        return parseResult(envelope.result);
      } catch (error) {
        if (error instanceof BrowserCollectionContractError) throw error;
        throw new BrowserRelayError("browser relay result validation failed");
      }
  }
}

function parseRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserRelayError("browser relay URL is invalid", "BROWSER_RELAY_CONFIG_INVALID");
  }
  const local =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "host.docker.internal";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new BrowserRelayError(
      "browser relay URL must use HTTPS outside localhost",
      "BROWSER_RELAY_CONFIG_INVALID",
    );
  }
  return url.toString();
}

function buildLocalToolUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (!url.pathname.endsWith("/mcp/request")) {
    throw new BrowserRelayError(
      "browser relay URL must end with /mcp/request",
      "BROWSER_RELAY_CONFIG_INVALID",
    );
  }
  url.pathname = `${url.pathname.slice(0, -"/mcp/request".length)}/mcp/local-tool`;
  return url.toString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripContractId(input) {
  const route = { ...input };
  delete route.contractId;
  return route;
}
