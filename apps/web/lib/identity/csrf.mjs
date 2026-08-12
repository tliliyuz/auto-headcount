/**
 * 管理端写操作 CSRF 防护（同源校验，纯函数可单测）。
 *
 * 变更方法（POST/PUT/PATCH/DELETE）校验 `Origin` 头与请求自身 origin 同源：
 * - 缺失 Origin（同源导航、curl 等非浏览器客户端）放行——主防线是 `SameSite=Lax`
 *   Cookie，本检查针对同站子域/代理等残余边界；
 * - 携带且跨源的 Origin 一律 403，阻断跨站表单/脚本的写请求。
 */
export function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const url = new URL(request.url);
  return originUrl.origin === url.origin;
}

/** 写路由入口调用：同源返回 null，跨源返回 403 包络响应。 */
export function requireSameOrigin(request) {
  if (isSameOrigin(request)) return null;
  return new Response(
    JSON.stringify({ code: "forbidden", message: "请求来源不合法" }),
    {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
