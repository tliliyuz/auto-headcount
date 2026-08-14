export class BrowserRouteConfigError extends Error {
  code: "BROWSER_ROUTE_CONFIG_REQUIRED";
}

export function resolveBrowserRouteConfig(env?: Record<string, string | undefined>): {
  userId: string;
  deviceId: string;
};

export function bindBrowserRoute<T extends Record<string, unknown>>(
  input: T,
  env?: Record<string, string | undefined>,
): T & { userId: string; deviceId: string };
