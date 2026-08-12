export declare const AUTH_ERROR_CODES: Readonly<{
  invalidCredentials: "invalid_credentials";
  locked: "account_locked";
  totpRequired: "totp_required";
  passwordPolicy: "password_policy_violation";
  unauthorized: "unauthorized";
  invalidRequest: "invalid_request";
}>;

export declare class AuthError extends Error {
  code: string;
  constructor(code: string, message: string);
}
