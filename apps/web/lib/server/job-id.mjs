/**
 * 从 `/api/jobs/{id}` 路径解析职位 UUID（纯函数，可单测）。
 * 路径缺 id、或末段不是 UUID 时返回 null——路由据此映射 `400 invalid_request`。
 * UUID 采用规范 8-4-4-4-12 十六进制（不强制小写）。
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseJobIdFromPathname(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];
  if (!id || !UUID_PATTERN.test(id)) return null;
  return id.toLowerCase();
}
