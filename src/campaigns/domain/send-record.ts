import type { Id } from '../../shared/ids/index.js';
import type { CampaignStats } from './campaign.js';
import { zeroStats } from './campaign.js';

/**
 * A send record's identity. This is the campaign's `sendId` — a plain app-owned
 * string `_id` (ADR-012), never a Mongo `ObjectId`.
 */
export type SendRecordId = Id;

/**
 * A single recipient's outcome within a send. The status is single-valued and
 * only ever **raised** by webhooks (never lowered) so out-of-order events
 * converge on the most significant terminal state.
 */
export const OUTCOME_STATUSES = [
  'pending',
  'rejected',
  'accepted',
  'delivered',
  'bounced',
  'complained',
] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

// Significance order used to raise a status. A more significant event wins
// regardless of arrival order (complaint > bounce > delivered > accepted …),
// so duplicate/out-of-order webhook delivery is tolerated (ADR-008).
const STATUS_PRIORITY: Record<OutcomeStatus, number> = {
  rejected: 0,
  pending: 1,
  accepted: 2,
  delivered: 3,
  bounced: 4,
  complained: 5,
};

/** The per-recipient outcome projection persisted (as JSON) on the send record. */
export interface RecipientOutcome {
  address: string;
  /** Provider message id assigned at send, or `null` (rejected / not yet sent). */
  messageId: string | null;
  status: OutcomeStatus;
  /** Provider error code at send (`0` = accepted). */
  errorCode: number;
  opens: number;
  clicks: number;
}

/** A normalized delivery event applied to the record (mapped from `email`). */
export interface DeliveryEventInput {
  /** One of `email`'s `DeliveryEventType`s; unknown types are ignored. */
  type: string;
  address: string;
  messageId: string | null;
}

/** An address that must be added to the suppression list (ADR-008). */
export interface SuppressionSignal {
  address: string;
  reason: 'hard-bounce' | 'spam-complaint';
}

/** The result of applying one delivery event: whether it was new + any suppression. */
export interface ApplyEventResult {
  /** `false` when the `(messageId|address, type)` key was already applied. */
  newlyApplied: boolean;
  suppress: SuppressionSignal | null;
}

/** Fully-resolved send-record state; the shape a repository reconstitutes from. */
export interface SendRecordProps {
  id: SendRecordId;
  campaignId: string;
  /** Postmark's bulk request id (async submission); null before submit. */
  bulkRequestId: string | null;
  /** When the provider accepted the broadcast; null before submit. */
  submittedAt: Date | null;
  outcomes: RecipientOutcome[];
  /** Dedupe keys of applied webhook events (`<messageId|address>:<type>`). */
  appliedEvents: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when opening a send record before the provider call. */
export interface CreateSendRecordProps {
  id: SendRecordId;
  campaignId: string;
  /** The gated recipient addresses; each starts `pending`. */
  addresses: readonly string[];
  now: Date;
}

function raise(current: OutcomeStatus, next: OutcomeStatus): OutcomeStatus {
  return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
}

/**
 * The send record aggregate (ADR-008): the per-recipient ledger for a
 * campaign's one send. Opened with `pending` outcomes **before** the provider
 * call (durable crash recovery), stamped with provider message ids/acceptance
 * afterwards, then mutated by webhooks — each event applied at most once,
 * keyed on `(messageId|address, type)`.
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage).
 */
export class SendRecord {
  private constructor(private props: SendRecordProps) {}

  static create(input: CreateSendRecordProps): SendRecord {
    const outcomes: RecipientOutcome[] = input.addresses.map((address) => ({
      address,
      messageId: null,
      status: 'pending',
      errorCode: 0,
      opens: 0,
      clicks: 0,
    }));
    return new SendRecord({
      id: input.id,
      campaignId: input.campaignId,
      bulkRequestId: null,
      submittedAt: null,
      outcomes,
      appliedEvents: [],
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: SendRecordProps): SendRecord {
    return new SendRecord(props);
  }

  /**
   * Record a successful provider submission (ADR-008): stamp the async bulk
   * request id + submission time and raise every still-`pending` recipient to
   * `accepted` — the broadcast was handed to the provider. Webhooks later raise
   * those to delivered/bounced/complained. An async bulk submit returns no
   * per-recipient message ids, so outcomes match webhooks by address.
   */
  markSubmitted(bulkRequestId: string, submittedAt: Date, now: Date): void {
    this.props.bulkRequestId = bulkRequestId;
    this.props.submittedAt = submittedAt;
    for (const outcome of this.props.outcomes) {
      if (outcome.status === 'pending') outcome.status = 'accepted';
    }
    this.props.updatedAt = now;
  }

  /**
   * Apply one normalized delivery event. Idempotent on the
   * `(messageId|address, type)` key — a duplicate is a no-op — and raises the
   * matched recipient's status (never lowers it). Hard bounces and spam
   * complaints return a suppression signal the caller pushes to the
   * deliverability list.
   */
  applyEvent(event: DeliveryEventInput, now: Date): ApplyEventResult {
    const keyBase = event.messageId ?? event.address;
    const key = `${keyBase}:${event.type}`;
    if (this.props.appliedEvents.includes(key)) {
      return { newlyApplied: false, suppress: null };
    }
    this.props.appliedEvents.push(key);
    this.props.updatedAt = now;

    const outcome = this.matchOutcome(event);

    let suppress: SuppressionSignal | null = null;
    switch (event.type) {
      case 'delivered':
        if (outcome) outcome.status = raise(outcome.status, 'delivered');
        break;
      case 'hard-bounce':
        if (outcome) outcome.status = raise(outcome.status, 'bounced');
        suppress = { address: event.address, reason: 'hard-bounce' };
        break;
      case 'spam-complaint':
        if (outcome) outcome.status = raise(outcome.status, 'complained');
        suppress = { address: event.address, reason: 'spam-complaint' };
        break;
      case 'open':
        if (outcome) outcome.opens += 1;
        break;
      case 'click':
        if (outcome) outcome.clicks += 1;
        break;
      default:
        break; // unknown event type: recorded (deduped) but no state change
    }
    return { newlyApplied: true, suppress };
  }

  /** Aggregate stats derived from the current per-recipient outcomes. */
  stats(): CampaignStats {
    const stats = zeroStats();
    stats.recipients = this.props.outcomes.length;
    for (const o of this.props.outcomes) {
      if (o.status === 'rejected' || o.status === 'pending') {
        if (o.status === 'rejected') stats.rejected += 1;
        continue;
      }
      stats.accepted += 1;
      if (o.status === 'delivered') stats.delivered += 1;
      else if (o.status === 'bounced') stats.bounced += 1;
      else if (o.status === 'complained') stats.complained += 1;
    }
    return stats;
  }

  private matchOutcome(event: DeliveryEventInput): RecipientOutcome | undefined {
    if (event.messageId !== null) {
      const byId = this.props.outcomes.find((o) => o.messageId === event.messageId);
      if (byId !== undefined) return byId;
    }
    return this.props.outcomes.find((o) => o.address === event.address);
  }

  get id(): SendRecordId {
    return this.props.id;
  }
  get campaignId(): string {
    return this.props.campaignId;
  }
  get bulkRequestId(): string | null {
    return this.props.bulkRequestId;
  }
  get submittedAt(): Date | null {
    return this.props.submittedAt;
  }
  get outcomes(): readonly RecipientOutcome[] {
    return this.props.outcomes;
  }
  get appliedEvents(): readonly string[] {
    return this.props.appliedEvents;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
