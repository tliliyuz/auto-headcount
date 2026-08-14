const IDENTIFIER = /^[A-Za-z0-9._:@/-]+$/;

export class BrowserRouteConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserRouteConfigError";
    this.code = "BROWSER_ROUTE_CONFIG_REQUIRED";
  }
}

/** 单设备 MVP：浏览器 owner/device 只能由服务端部署配置注入。 */
export function resolveBrowserRouteConfig(env = process.env) {
  return {
    userId: requireIdentifier(env.BROWSER_RELAY_USER_ID, "BROWSER_RELAY_USER_ID"),
    deviceId: requireIdentifier(env.BROWSER_RELAY_DEVICE_ID, "BROWSER_RELAY_DEVICE_ID"),
  };
}

export function bindBrowserRoute(input, env = process.env) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrowserRouteConfigError("browser collection input must be an object");
  }
  return { ...input, ...resolveBrowserRouteConfig(env) };
}

function requireIdentifier(value, name) {
  if (typeof value !== "string") throw new BrowserRouteConfigError(`${name} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || !IDENTIFIER.test(normalized)) {
    throw new BrowserRouteConfigError(`${name} is invalid`);
  }
  return normalized;
}
