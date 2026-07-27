import type { MergeFields, SubscriptionStatus } from '../domain/subscription.js';

/**
 * Application-layer input DTOs: plain, validated primitives handed to use cases
 * (ADR-006 — validation happens at the HTTP edge; use cases never see a Hono
 * `Context`). Output is the domain `Subscription`, mapped to a response DTO by
 * the presentation layer — entities are never serialized directly (ADR-004).
 */

export interface SubscribeInput {
  newsletterId: string;
  email: string;
  mergeFields?: MergeFields;
  tags?: string[];
  /**
   * Per-newsletter opt-in toggle. `true` (the default) → the subscription is
   * created `pending` and one confirmation email is sent; `false` (single
   * opt-in) → it is created `subscribed` with no email.
   */
  doubleOptIn?: boolean;
}

/**
 * What an import does when a row's address already has a membership in the
 * newsletter (ADR-022). Exactly two modes, and `skip` is the default.
 *
 * There is deliberately no third "merge" mode: a behaviour that is neither
 * "leave the row alone" nor "the file is the truth" cannot be described in one
 * sentence, so nobody can predict afterwards what an import did to their data.
 */
export type ImportConflictMode = 'skip' | 'overwrite';

/** One row of an import batch — already validated primitives (ADR-006). */
export interface ImportSubscriptionRow {
  email: string;
  /** The restored status. Absent → the batch's `defaultStatus`. */
  status?: SubscriptionStatus;
  mergeFields?: MergeFields;
  tags?: string[];
  /** The original opt-in date from the source system; becomes `createdAt`. */
  subscribedAt?: Date;
}

export interface ImportSubscriptionsInput {
  newsletterId: string;
  rows: readonly ImportSubscriptionRow[];
  /** Defaults to `skip` — an import never overwrites unless asked to. */
  onConflict?: ImportConflictMode;
  /** Status for rows that carry none. Defaults to `subscribed`. */
  defaultStatus?: SubscriptionStatus;
}

/** What one import batch did, for progress reporting and the dry-run summary. */
export interface ImportSubscriptionsResult {
  /** Rows in the batch, including duplicates and skipped ones. */
  received: number;
  created: number;
  updated: number;
  /** Existing rows left untouched, plus repeats of an address within the batch. */
  skipped: number;
  /** Addresses sent to the **global** suppression list (imported hard bounces). */
  suppressed: number;
  /** Status breakdown of the rows this batch actually wrote. */
  byStatus: Record<SubscriptionStatus, number>;
}

export interface ListSubscriptionsInput {
  newsletterId: string;
  status?: SubscriptionStatus;
  tag?: string;
  /** Page size requested by the caller. */
  limit: number;
  cursor?: string;
}
