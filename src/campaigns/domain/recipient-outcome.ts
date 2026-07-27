import type { Id } from '../../shared/ids/index.js';

/**
 * One recipient's outcome within a send — now its own aggregate, one document
 * per recipient (ADR-019).
 *
 * The status is single-valued and only ever **raised**, never lowered, so
 * duplicate and out-of-order webhook delivery converge on the most significant
 * terminal state. That "only raise" rule is what makes the write expressible as
 * a single conditional update (`WHERE statusPriority < n`) and therefore atomic
 * without a transaction or a read (ADR-012).
 */
export type RecipientOutcomeId = Id;

export const OUTCOME_STATUSES = [
  'pending',
  'rejected',
  'accepted',
  'delivered',
  'soft-bounced',
  'bounced',
  'complained',
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/**
 * Significance order. A more significant event wins regardless of arrival
 * order (complaint > bounce > delivered > accepted …).
 *
 * This is **persisted** alongside the label, not just used in memory: the
 * repository's conditional update filters on `statusPriority < n`, so the
 * ordering has to be a value the store can compare. Storing the label too
 * keeps queries and reports readable without a lookup.
 */
export const STATUS_PRIORITY: Record<OutcomeStatus, number> = {
  rejected: 0,
  pending: 1,
  accepted: 2,
  delivered: 3,
  // Above `delivered` on purpose. The two are mutually exclusive in practice —
  // Postmark either eventually delivers (Delivery webhook, no bounce) or gives
  // up (SoftBounce webhook, no delivery) — but if both ever arrive, "we stopped
  // trying" is the truthful outcome, so it must not be overwritten.
  'soft-bounced': 4,
  bounced: 5,
  complained: 6,
};

export function priorityOf(status: OutcomeStatus): number {
  return STATUS_PRIORITY[status];
}

export interface RecipientOutcomeProps {
  id: RecipientOutcomeId;
  sendId: string;
  /** Denormalized from the send so a report can query outcomes by campaign directly. */
  campaignId: string;
  address: string;
  /** Provider message id, or `null` — an async bulk submit returns none. */
  messageId: string | null;
  status: OutcomeStatus;
  statusPriority: number;
  opens: number;
  clicks: number;
  /**
   * Dedupe keys of webhook events already applied to **this recipient**.
   *
   * Bounded and small — a handful of terminal events plus one per open/click —
   * unlike the old per-send `appliedEvents`, which grew to one entry per event
   * across every recipient (~54k for an 18k send) and was scanned linearly on
   * every webhook.
   */
  applied: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecipientOutcomeProps {
  id: RecipientOutcomeId;
  sendId: string;
  campaignId: string;
  address: string;
  now: Date;
}

/** A normalized delivery event applied to an outcome (mapped from `email`). */
export interface DeliveryEventInput {
  /** One of `email`'s `DeliveryEventType`s; unknown types are ignored. */
  type: string;
  address: string;
  messageId: string | null;
  /** When the event occurred at the provider — part of the dedupe key for repeatable events. */
  occurredAt: Date | null;
}

/** An address that must be added to the suppression list (ADR-008). */
export interface SuppressionSignal {
  address: string;
  reason: 'hard-bounce' | 'spam-complaint';
}

/**
 * What an event does to a recipient's outcome. The domain decides the *intent*;
 * the repository turns it into one atomic store operation.
 *
 * Splitting it this way is what lets the write stay a single conditional update
 * with no read-modify-write — the aggregate cannot mutate itself in memory and
 * be saved back, because that is precisely the pattern that lost updates.
 */
export type OutcomeEffect =
  | { readonly kind: 'raise'; readonly status: OutcomeStatus }
  | { readonly kind: 'count'; readonly field: 'opens' | 'clicks' }
  | { readonly kind: 'ignore' };

/**
 * A per-newsletter membership status change (ADR-018). Distinct from
 * {@link SuppressionSignal}, and that distinction is the point: a bounce is a
 * fact about the **address** and goes on the global list; a complaint is a fact
 * about **this newsletter** and must not.
 */
export type SubscriptionOutcomeSignal =
  | 'bounced'
  | 'complained'
  /** Increment this membership's consecutive-soft-bounce counter (ADR-020). */
  | 'soft-bounce'
  /** Reset that counter — the mailbox is demonstrably working again. */
  | 'delivered';

export interface EventEffect {
  readonly effect: OutcomeEffect;
  /** The **global**, address-keyed deny list. Permanent bounces only. */
  readonly suppress: SuppressionSignal | null;
  /** The **per-newsletter** membership status. Bounces and complaints both. */
  readonly subscription: SubscriptionOutcomeSignal | null;
  /**
   * The key that makes this event idempotent, or `null` if it should not be
   * deduped at all.
   */
  readonly dedupeKey: string | null;
}

/**
 * Maps a normalized delivery event to its effect. Pure.
 *
 * **Dedupe keys differ by event kind, and that is the fix for a real bug.**
 * Terminal events (delivered/bounce/complaint) happen once per message, so
 * their key is `<messageId|address>:<type>` — a provider retry is discarded.
 * Opens and clicks legitimately *repeat*: Postmark POSTs one webhook per open.
 * The previous implementation used the same key shape for them, so the second
 * open for a message was discarded and `opens` could never exceed 1 — a field
 * that looked and was typed like a counter but behaved like a boolean.
 *
 * Including `occurredAt` in the key keeps genuine repeat opens counted while
 * still discarding a retry of the *same* event, which carries the same
 * timestamp. When the provider sends no timestamp the event is not deduped at
 * all: over-counting an open is a far smaller harm than silently dropping every
 * open after the first.
 */
export function effectOf(event: DeliveryEventInput): EventEffect {
  const keyBase = event.messageId ?? event.address;

  switch (event.type) {
    case 'delivered':
      // Also resets the membership's soft-bounce streak (ADR-020): the mailbox
      // accepted mail, so whatever was wrong with it is over.
      return {
        effect: { kind: 'raise', status: 'delivered' },
        suppress: null,
        subscription: 'delivered',
        dedupeKey: `${keyBase}:delivered`,
      };
    case 'hard-bounce':
      // BOTH: the mailbox is dead for everyone (global list), and this
      // newsletter's membership records the observed failure (ADR-018).
      return {
        effect: { kind: 'raise', status: 'bounced' },
        suppress: { address: event.address, reason: 'hard-bounce' },
        subscription: 'bounced',
        dedupeKey: `${keyBase}:hard-bounce`,
      };
    case 'soft-bounce':
      // Never suppresses and never marks the membership bounced on its own —
      // it is not proof the mailbox is gone. It increments a streak, and the
      // subscriptions context decides when repetition becomes a verdict.
      return {
        effect: { kind: 'raise', status: 'soft-bounced' },
        suppress: null,
        subscription: 'soft-bounce',
        dedupeKey: `${keyBase}:soft-bounce:${event.occurredAt?.toISOString() ?? 'na'}`,
      };
    case 'spam-complaint':
      // Per-newsletter ONLY. A complaint about one publication is not a
      // statement about every publication the operator runs, so it must never
      // reach the global deny list (ADR-018).
      return {
        effect: { kind: 'raise', status: 'complained' },
        suppress: null,
        subscription: 'complained',
        dedupeKey: `${keyBase}:spam-complaint`,
      };
    case 'open':
    case 'click': {
      const field = event.type === 'open' ? 'opens' : 'clicks';
      return {
        effect: { kind: 'count', field },
        suppress: null,
        subscription: null,
        dedupeKey:
          event.occurredAt === null
            ? null
            : `${keyBase}:${event.type}:${event.occurredAt.toISOString()}`,
      };
    }
    default:
      // An unrecognized type changes nothing. Not an error: Postmark adds
      // record types over time and the receiver must keep succeeding (ADR-008).
      return { effect: { kind: 'ignore' }, suppress: null, subscription: null, dedupeKey: null };
  }
}

/**
 * The recipient-outcome aggregate. Read-side only — mutations go through the
 * repository as atomic updates derived from {@link effectOf}, never by loading
 * this object, changing it, and writing it back.
 */
export class RecipientOutcome {
  private constructor(private readonly props: RecipientOutcomeProps) {}

  static create(input: CreateRecipientOutcomeProps): RecipientOutcome {
    return new RecipientOutcome({
      id: input.id,
      sendId: input.sendId,
      campaignId: input.campaignId,
      address: input.address,
      messageId: null,
      status: 'pending',
      statusPriority: STATUS_PRIORITY.pending,
      opens: 0,
      clicks: 0,
      applied: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static reconstitute(props: RecipientOutcomeProps): RecipientOutcome {
    return new RecipientOutcome(props);
  }

  get id(): RecipientOutcomeId {
    return this.props.id;
  }
  get sendId(): string {
    return this.props.sendId;
  }
  get campaignId(): string {
    return this.props.campaignId;
  }
  get address(): string {
    return this.props.address;
  }
  get messageId(): string | null {
    return this.props.messageId;
  }
  get status(): OutcomeStatus {
    return this.props.status;
  }
  get opens(): number {
    return this.props.opens;
  }
  get clicks(): number {
    return this.props.clicks;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
