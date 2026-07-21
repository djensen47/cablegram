import { randomUUID } from 'node:crypto';

/**
 * An application-owned identifier. A plain string (a UUID), deliberately *not*
 * a Mongo `ObjectId` — keeping provider id types out of the domain preserves
 * DB portability (ADR-012). Stored as the `_id` string by each repository.
 */
export type Id = string;

/** Generate a new identifier. */
export function newId(): Id {
  return randomUUID();
}
