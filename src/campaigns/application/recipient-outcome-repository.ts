import type { CampaignStats } from '../domain/campaign.js';
import type { OutcomeEffect, OutcomeStatus, RecipientOutcome } from '../domain/recipient-outcome.js';

/** One webhook's worth of change, addressed to a single recipient's row. */
export interface ApplyOutcomeEvent {
  sendId: string;
  address: string;
  /** What to change — from the domain's `effectOf`. */
  effect: OutcomeEffect;
  /** Idempotency key, or `null` when the event should not be deduped. */
  dedupeKey: string | null;
  now: Date;
}

/** Forward-only, cursor-paginated listing of a send's recipients. */
export interface ListOutcomesOptions {
  sendId: string;
  /** Optional filter, e.g. only failures for a report. */
  statuses?: readonly OutcomeStatus[];
  limit: number;
  /** Exclusive lower bound: outcomes whose id sorts after this one. */
  cursor?: string;
}

/**
 * Persistence gateway for per-recipient outcomes (ADR-019).
 *
 * The shape of this interface is deliberate. There is **no `update(outcome)`**,
 * because a read-modify-write of a whole aggregate is exactly what this
 * redesign removes: webhooks arrive concurrently, and last-writer-wins on a
 * loaded object silently discards other events. `applyEvent` instead describes
 * an intent that an implementation must satisfy **atomically on one document**
 * — which needs no transaction, consistent with ADR-012's "every write is a
 * single document" rule.
 */
export interface RecipientOutcomeRepository {
  /** Open the ledger for a send. One document per gated recipient. */
  createMany(outcomes: readonly RecipientOutcome[]): Promise<void>;

  /**
   * Raise every still-`pending` recipient of a send to `accepted` — the
   * broadcast was handed to the provider. A bulk operation on the store, not a
   * loop that loads and saves each row.
   */
  markAccepted(sendId: string, now: Date): Promise<void>;

  /**
   * Apply one event to one recipient, atomically and idempotently.
   *
   * Returns whether anything actually changed: `false` for a duplicate, and
   * also for an event that arrives after a more significant one (a `delivered`
   * landing after a `bounced` must not lower the status). Callers use it only
   * for reporting — suppression is driven by the event itself, not by whether a
   * matching recipient row existed.
   */
  applyEvent(event: ApplyOutcomeEvent): Promise<boolean>;

  /** Aggregate stats for a send, computed from the outcomes themselves. */
  stats(sendId: string): Promise<CampaignStats>;

  list(options: ListOutcomesOptions): Promise<RecipientOutcome[]>;
}
