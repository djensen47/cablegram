import type { User } from '../domain/user.js';

/** Options for a forward-only, cursor-paginated list (ADR-012 portable subset). */
export interface ListUsersOptions {
  /** Max rows to return. Callers pass `pageSize + 1` to detect a next page. */
  limit: number;
  /** Exclusive lower bound: return users whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for user accounts. Lives in `application/` next to its
 * consumers (ADR-001) — the MongoDB native driver is one implementation behind
 * it (ADR-012), the in-memory double another. Deals in domain aggregates,
 * never driver documents or DTOs.
 *
 * `email` everywhere here is a **normalized** address (`shared/email-address`)
 * — callers normalize before calling in, so `findByEmail` does an exact-match
 * lookup against the unique index.
 */
export interface UserRepository {
  create(user: User): Promise<void>;
  update(user: User): Promise<void>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Users ordered by id ascending, `id > cursor`, capped at `limit`. */
  list(options: ListUsersOptions): Promise<User[]>;
  /** Total user count — the first-user-becomes-admin bootstrap check (ADR-013). */
  countAll(): Promise<number>;
}
