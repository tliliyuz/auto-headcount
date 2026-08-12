export function parsePagination(
  url: URL,
  opts?: { defaultPageSize?: number; maxPageSize?: number },
):
  | { ok: true; page: number; pageSize: number }
  | { ok: false; reason: string };
