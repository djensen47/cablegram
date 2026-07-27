/** One bucket of provider events cablegram received but did not act on. */
export interface UnhandledEventRecord {
  /** The bucket key — a `RecordType`, a `RecordType:Detail` pair, or a sentinel. */
  key: string;
  /** How many payloads have landed in this bucket. */
  count: number;
  /** The **first** payload seen for this key, JSON-serialized and truncated. */
  sample: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** One payload's worth of "we didn't handle this", addressed to its bucket. */
export interface RecordUnhandledEvent {
  key: string;
  sample: string;
  now: Date;
}

/**
 * The record of provider events cablegram received but could not act on
 * (issue #29).
 *
 * This exists because the alternative — a log line — is not observability on
 * DigitalOcean Functions, where activation logs cannot be searched, aggregated
 * or alerted on. A log line answers "what happened during this invocation"; the
 * question worth answering is "is Postmark sending us anything we're dropping?",
 * and that one needs queryable state.
 *
 * The shape is deliberately **per distinct key, not per event**: one row per
 * kind of surprise, upserted. That keeps it bounded to a handful of documents
 * forever — no TTL, no retention policy, no growth risk at 50k webhooks per
 * send — and it makes `record` a single-document write, which is all ADR-012
 * allows without a transaction.
 */
export interface UnhandledEventRepository {
  /**
   * Count one occurrence, atomically. Creates the bucket on first sight
   * (keeping that payload as the sample) and only bumps the count and
   * `lastSeenAt` thereafter.
   */
  record(entry: RecordUnhandledEvent): Promise<void>;

  /**
   * Every bucket, most-frequent first. Not paginated: the collection is bounded
   * by the number of distinct record types, so a page would only ever be a page
   * of everything.
   */
  list(): Promise<UnhandledEventRecord[]>;
}
