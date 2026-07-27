import type { Id } from '../../shared/ids/index.js';

/**
 * A send's identity — the campaign's `sendId`. A plain app-owned string `_id`
 * (ADR-012), never a Mongo `ObjectId`.
 */
export type SendId = Id;

/**
 * One campaign send: the **submission facts only** (ADR-019).
 *
 * This used to be `SendRecord`, which also carried an `outcomes` array with one
 * entry per recipient and an `appliedEvents` array with one entry per webhook.
 * At 18k recipients that document reached ~5 MB and every one of ~54k webhooks
 * read it whole, mutated it, and wrote it back — with no optimistic
 * concurrency, so concurrent webhooks silently overwrote each other's outcomes.
 *
 * Per-recipient state now lives in `campaign_recipient_outcomes`, one document
 * each. What remains here is small, bounded, and written exactly twice: once
 * when the send is opened, once when the provider acknowledges it.
 */
export interface SendProps {
  id: SendId;
  campaignId: string;
  /** Postmark's bulk request id (async submission); null before submit. */
  bulkRequestId: string | null;
  /** When the provider accepted the broadcast; null before submit. */
  submittedAt: Date | null;
  /**
   * How many recipients survived both send gates. Stored rather than counted,
   * so the denominator is a fact about the send itself and stays correct even
   * if outcome rows are later archived.
   */
  recipientCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSendProps {
  id: SendId;
  campaignId: string;
  recipientCount: number;
  now: Date;
}

/**
 * The send aggregate (ADR-008, ADR-019). Opened **before** the provider call so
 * a crash mid-send still leaves a durable record, then stamped with the
 * provider's acknowledgement.
 *
 * Constructed only through `create` (new) or `reconstitute` (from storage).
 */
export class Send {
  private constructor(private props: SendProps) {}

  static create(input: CreateSendProps): Send {
    return new Send({
      id: input.id,
      campaignId: input.campaignId,
      bulkRequestId: null,
      submittedAt: null,
      recipientCount: input.recipientCount,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuild an aggregate from persisted state without re-validating. */
  static reconstitute(props: SendProps): Send {
    return new Send(props);
  }

  /**
   * Record a successful provider submission (ADR-008): the async bulk request
   * id and the time the provider accepted the broadcast. Raising the
   * recipients themselves from `pending` to `accepted` is a separate, bulk
   * operation on the outcomes collection — it is no longer an in-memory loop
   * over an embedded array.
   */
  markSubmitted(bulkRequestId: string, submittedAt: Date, now: Date): void {
    this.props.bulkRequestId = bulkRequestId;
    this.props.submittedAt = submittedAt;
    this.props.updatedAt = now;
  }

  get id(): SendId {
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
  get recipientCount(): number {
    return this.props.recipientCount;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
