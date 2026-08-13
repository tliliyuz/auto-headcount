/** 匹配 id：从路径末段解析 UUID（Vinext 动态路由不把 params 传给 withAudit handler，须自解析）。 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMatchIdFromPathname(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || !UUID_RE.test(last)) return null;
  return last.toLowerCase();
}
