import type {
  ConsentEvidence,
  ImportedConsentRecord,
  MergeFields,
  SubscriptionStatus,
} from '../domain/subscription.js';

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
  /**
   * Who submitted the signup (ADR-023) — supplied by the operator's front end,
   * never read off this request. cablegram is headless: the caller here is the
   * operator's backend, so its IP is the operator's, not the subscriber's.
   */
  evidence?: ConsentEvidence;
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
  /** Per-row provenance override. Absent → the batch's `source`. */
  source?: string;
  /**
   * The consent trail as the source system recorded it (ADR-023). An export
   * carrying opt-in IPs is carrying evidence that cannot be reconstructed once
   * dropped, so it is restored verbatim rather than re-derived.
   */
  consent?: ImportedConsentRecord;
}

export interface ImportSubscriptionsInput {
  newsletterId: string;
  rows: readonly ImportSubscriptionRow[];
  /** Defaults to `skip` — an import never overwrites unless asked to. */
  onConflict?: ImportConflictMode;
  /** Status for rows that carry none. Defaults to `subscribed`. */
  defaultStatus?: SubscriptionStatus;
  /**
   * Where this batch came from — e.g. `mailchimp-export-2026-07`. Recorded on
   * every row it writes, so an inherited consent claim stays distinguishable
   * from one cablegram witnessed itself.
   *
   * Optional, but never absent from the stored record: an import with no note
   * falls back to `import`. The point of the field is that an imported row is
   * *always* identifiable as imported, and a property that holds only when the
   * operator remembers a flag is not a property you can audit against.
   */
  source?: string;
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
