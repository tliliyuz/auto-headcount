/**
 * 客户端侧认证 API 封装（纯 fetch，无服务端依赖，供 "use client" 组件使用）。
 * 契约见 docs/09-api-contract.md §2.1；会话由 HttpOnly Cookie 承载，
 * 客户端不保存口令或令牌。
 */

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

export type AuthSession = {
  user: AuthUser;
  roles: string[];
  passwordChangeRequired: boolean;
};

export type AuthResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string };

type ErrorBody = { code?: unknown; message?: unknown };

export async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<AuthResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    // 主动取消（AbortController.abort）：返回可识别的 aborted 标记，调用方（cancelled 标记 /
    // signal.aborted 检查）静默忽略，不再产生 unhandled AbortError。其余网络错误保持原拒绝语义，
    // 既有调用方的 try/catch 契约不变。
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") {
      return { ok: false, status: 0, code: "aborted", message: "请求已取消" };
    }
    throw error;
  }
  if (response.status === 204) {
    return { ok: true, data: undefined as T };
  }

  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof body?.code === "string" ? body.code : "unknown_error",
      message:
        typeof body?.message === "string"
          ? body.message
          : "请求失败，请稍后再试",
    };
  }
  return { ok: true, data: body as T };
}

export function loginRequest(input: {
  username: string;
  password: string;
  totpCode?: string;
}): Promise<AuthResult<AuthSession>> {
  return request<AuthSession>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function meRequest(): Promise<AuthResult<AuthSession>> {
  return request<AuthSession>("/api/auth/me", { method: "GET" });
}

export function logoutRequest(): Promise<AuthResult<null>> {
  return request<null>("/api/auth/logout", { method: "POST" });
}

export function changePasswordRequest(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<AuthResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
