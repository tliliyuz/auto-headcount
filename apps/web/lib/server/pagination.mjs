/**
 * 分页参数解析与夹取：page 从 1 起、page_size 正整数且不超过 maxPageSize。
 * 纯函数，供只读 Route Handler 统一使用（契约 §1 分页包络）。
 */
export function parsePagination(
  url,
  { defaultPageSize = 20, maxPageSize = 100 } = {},
) {
  const rawPage = url.searchParams.get("page");
  const rawSize = url.searchParams.get("page_size");
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawSize === null ? defaultPageSize : Number(rawSize);

  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, reason: "page 必须是正整数" };
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return { ok: false, reason: "page_size 必须是正整数" };
  }
  return { ok: true, page, pageSize: Math.min(pageSize, maxPageSize) };
}
