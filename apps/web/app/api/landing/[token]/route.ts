import { jsonResponse } from "../../../../lib/identity/auth-http";
import { getLandingJobView } from "../../../../lib/landing/landing-intent-service.mjs";
import { getDb } from "../../../../lib/server/db";

/**
 * 公开侧落地页视图（独立身份域，令牌门禁，无会话）：返回脱敏职位 DTO。
 * 令牌不存在/已过期/已撤销统一 `404 landing_link_unavailable`，防令牌枚举。
 * 公开只读视图不写审计（避免页浏览量噪音）；意向提交与通知审计在 intent 路由。
 */
export async function GET(request: Request): Promise<Response> {
  const token = parseTokenFromPathname(new URL(request.url).pathname);
  if (!token) {
    return jsonResponse(
      { code: "landing_link_unavailable", message: "落地页链接不可用" },
      404,
    );
  }
  const { client } = getDb();
  const view = await getLandingJobView(client, { token, now: new Date() });
  if (!view) {
    return jsonResponse(
      { code: "landing_link_unavailable", message: "落地页链接不可用" },
      404,
    );
  }
  return jsonResponse(view, 200);
}

function parseTokenFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? decodeURIComponent(last) : null;
}
