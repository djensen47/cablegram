import { injectable } from 'inversify';

/** A cached response, keyed by `(method, path, Idempotency-Key)` (idempotency.ts). */
export interface IdempotencyRecord {
  /** SHA-256 of the request body — detects a key reused with a different body. */
  fingerprint: string;
  status: number;
  contentType: string | undefined;
  body: string;
}

/**
 * Storage for the `Idempotency-Key` middleware (`idempotency.ts`). A
 * repository-shaped seam (ADR-007's "the repository is the swap seam" stance
 * applied to this cross-cutting concern, not persistence): the in-memory
 * default below is what's bound; a durable implementation (e.g. Mongo-backed,
 * with a TTL index) binds behind the same interface with no change to the
 * middleware or the routes it wraps.
 */
export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
}

/**
 * The default `IdempotencyStore` (ADR-009): a plain `Map`, held at module/
 * container scope so it survives across requests within one warm process —
 * durable for the whole lifetime of Docker's long-lived process, best-effort
 * under DO Functions' statelessness (a cold start loses it, no worse than a
 * client's retry landing on a fresh instance with no prior key). Not a
 * correctness requirement — the guarantee `Idempotency-Key` provides is "don't
 * double-execute the mutation right now, on this instance," which is exactly
 * what this store can promise.
 */
@injectable()
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return this.store.get(key);
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    this.store.set(key, record);
  }
}
