import type { SuppressionEntry } from '../domain/suppression.js';

/** Options for a forward-only, cursor-paginated list (ADR-007 portable subset). */
export interface ListSuppressionsOptions {
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return entries whose address sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for the suppression list. Lives in `application/` next
 * to its consumers (ADR-001) — Prisma is one implementation behind it
 * (ADR-007), the in-memory double another. Deals in domain aggregates, never
 * Prisma rows or DTOs.
 *
 * `address` everywhere here is a **normalized** address (`shared/email-address`)
 * — callers normalize before calling in, so `findByAddress`/`filterSuppressed`
 * can do exact-match lookups against the unique index.
 */
export interface SuppressionRepository {
  /**
   * Adds a suppression entry. Idempotent: adding an address already suppressed
   * is a no-op that leaves the existing entry (its original reason/timestamp)
   * untouched — repeated hard-bounce/complaint events for the same address
   * never overwrite the first record.
   */
  add(entry: SuppressionEntry): Promise<SuppressionEntry>;
  findByAddress(address: string): Promise<SuppressionEntry | null>;
  /** Entries ordered by address ascending, `address > cursor`, capped at `limit`. */
  list(options: ListSuppressionsOptions): Promise<SuppressionEntry[]>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  remove(address: string): Promise<boolean>;
  /**
   * Batch membership check — the send path's gate (ADR-011): given a list of
   * normalized addresses, returns the subset that is currently suppressed.
   */
  filterSuppressed(addresses: string[]): Promise<string[]>;
}
