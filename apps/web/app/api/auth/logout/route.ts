import {
  getAuthContext,
  isSecureCookieRuntime,
  newRequestId,
  readSessionToken,
  writeAudit,
} from "../../../../lib/identity/auth-http";
import { clearSessionCookie } from "../../../../lib/identity/session-token.mjs";
import { requireSameOrigin } from "../../../../lib/identity/csrf.mjs";

export async function POST(request: Request): Promise<Response> {
  const csrfBlock = requireSameOrigin(request);
  if (csrfBlock) return csrfBlock;

  const requestId = newRequestId();
  const { service, repo } = getAuthContext();
  const token = readSessionToken(request);

  if (token) {
    const sessionUser = await service.getSessionUser(token);
    await service.revokeSession(token);
    await writeAudit(repo, {
      actorType: "user",
      actorId: sessionUser?.user.id ?? null,
      action: "auth.logout",
      resourceType: "user",
      resourceId: sessionUser?.user.id ?? null,
      result: "success",
      requestId,
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": clearSessionCookie({ secure: isSecureCookieRuntime() }),
    },
  });
}
