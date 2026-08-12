/**
 * 分页参数解析与夹取：page 从 1 起且不超过 maxPage，page_size 正整数且不超过 maxPageSize。
 * 纯函数，供只读 Route Handler 统一使用（契约 §1 分页包络）。
 * maxPage 防止超大 page 令 (page-1)*pageSize 溢出 bigint offset（超上限明确拒绝，而非 500）。
 */
export function parsePagination(
  url,
  { defaultPageSize = 20, maxPageSize = 100, maxPage = 1_000_000 } = {},
) {
  const rawPage = url.searchParams.get("page");
  const rawSize = url.searchParams.get("page_size");
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawSize === null ? defaultPageSize : Number(rawSize);

  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, reason: "page 必须是正整数" };
  }
  if (page > maxPage) {
    return { ok: false, reason: `page 不能超过 ${maxPage}` };
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return { ok: false, reason: "page_size 必须是正整数" };
  }
  return { ok: true, page, pageSize: Math.min(pageSize, maxPageSize) };
}
