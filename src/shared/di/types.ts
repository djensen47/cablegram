/**
 * DI tokens (ADR-003). Shared-kernel tokens live here; each domain component
 * exports its own `TYPES` that the composition root merges in as it's added.
 */
export const TYPES = {
  Config: Symbol.for('Config'),
  Clock: Symbol.for('Clock'),
  /**
   * The pooled `MongoClient` (native driver), owned by the composition root
   * (ADR-012, ADR-009 — one pool at module scope, reused across warm
   * invocations). Bound lazily so tests that rebind repositories to in-memory
   * doubles never construct a client or open a connection.
   */
  MongoClient: Symbol.for('MongoClient'),
  /**
   * The MongoDB `Db` handle derived from the pooled `MongoClient`, shared by
   * every component's Mongo repository (ADR-012). Also bound lazily — a repo
   * only touches it inside an async method, so no connection opens until an
   * actual query runs.
   */
  MongoDb: Symbol.for('MongoDb'),
  /** Storage for the `Idempotency-Key` middleware (`shared/http`); in-memory by
   * default, bound at container scope so it persists across requests within
   * one warm process (see `InMemoryIdempotencyStore`'s docstring, ADR-009). */
  IdempotencyStore: Symbol.for('IdempotencyStore'),
} as const;
