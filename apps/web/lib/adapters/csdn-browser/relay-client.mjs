import {
  BrowserCollectionContractError,
  CSDN_CONNECTION_STATUS_TOOL,
  CSDN_EXTRACTION_TOOL,
  buildBrowserConnectionStatusArguments,
  buildJobDetailExtractionArguments,
  parseJobDetailExtractionResult,
  parseBrowserConnectionStatusResult,
} from "./browser-collection-contract.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

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
      return callRelayTool(CSDN_CONNECTION_STATUS_TOOL, buildBrowserConnectionStatusArguments(input), parseBrowserConnectionStatusResult);
    },
    async extractJobDetail(input) {
      return callRelayTool(CSDN_EXTRACTION_TOOL, buildJobDetailExtractionArguments(input), parseJobDetailExtractionResult);
    },
  };

  async function callRelayTool(tool, args, parseResult) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
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
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new BrowserRelayError(
      "browser relay URL must use HTTPS outside localhost",
      "BROWSER_RELAY_CONFIG_INVALID",
    );
  }
  return url.toString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
