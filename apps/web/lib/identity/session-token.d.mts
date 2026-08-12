export declare const SESSION_COOKIE_NAME: string;
export declare const SESSION_IDLE_MS: number;
export declare const SESSION_MAX_MS: number;

export declare function generateSessionToken(): Promise<{
  token: string;
  tokenHash: string;
}>;

export declare function hashSessionToken(token: string): Promise<string>;

export declare function sessionCookieValue(
  token: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): string;

export declare function clearSessionCookie(opts?: {
  secure?: boolean;
}): string;

export declare function parseSessionToken(cookieHeader: string | null): string | null;
