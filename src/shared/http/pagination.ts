import { z } from 'zod';

/**
 * Cursor pagination for list endpoints. The cursor is an opaque, id-based
 * marker (the `_id` of the last row of the previous page); it keeps pagination
 * portable across stores (ADR-012) — a `WHERE id > cursor ORDER BY id` sweep,
 * no offset/skip, no store-specific aggregation.
 *
 * The wire envelope is `{ data, meta: { nextCursor } }`; `nextCursor` is `null`
 * on the last page. Every list route reuses this shape.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Query-string schema shared by list routes: `?limit=&cursor=`. */
export const paginationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** A page of results plus the cursor to fetch the next one (`null` when done). */
export interface Page<T> {
  data: T[];
  meta: { nextCursor: string | null };
}

/**
 * Splits a "limit + 1" fetch into a page. Callers ask the repository for one
 * more row than the page size; if it comes back, there is a next page and its
 * cursor is the last in-page row's id.
 *
 * @param rows  up to `limit + 1` items, already ordered by their cursor key
 * @param limit the requested page size
 * @param cursorOf extracts the cursor (id) from a row
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    meta: { nextCursor: hasMore && last !== undefined ? cursorOf(last) : null },
  };
}
