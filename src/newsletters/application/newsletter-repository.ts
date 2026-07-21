import type { Newsletter, NewsletterId } from '../domain/newsletter.js';

/** Options for a forward-only, cursor-paginated list (ADR-007 portable subset). */
export interface ListNewslettersOptions {
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return newsletters whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for newsletters. Lives in `application/` next to its
 * consumers (ADR-001) — the MongoDB native driver is one implementation behind it (ADR-012), the
 * in-memory double another. Repositories deal in domain aggregates, never
 * driver documents or DTOs.
 */
export interface NewsletterRepository {
  create(newsletter: Newsletter): Promise<void>;
  findById(id: NewsletterId): Promise<Newsletter | null>;
  /** Newsletters ordered by id ascending, `id > cursor`, capped at `limit`. */
  list(options: ListNewslettersOptions): Promise<Newsletter[]>;
  update(newsletter: Newsletter): Promise<void>;
  /** Returns `true` if a row was deleted, `false` if none existed. */
  delete(id: NewsletterId): Promise<boolean>;
}
