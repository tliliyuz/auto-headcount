/** 管理端写操作 CSRF 同源校验：携带且跨源的 Origin 返回 403，缺失 Origin 放行。 */
export function isSameOrigin(request: Request): boolean;
export function requireSameOrigin(request: Request): Response | null;
