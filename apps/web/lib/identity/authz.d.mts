export function authorizeOrForbidden(
  user: { roles?: string[] } | null | undefined,
  allowedRoles: string[],
  opts?: { message?: string },
): Response | null;
