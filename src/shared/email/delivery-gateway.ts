/**
 * The email delivery gateway — cablegram's anti-corruption layer over the
 * email provider (Postmark, ADR-008). A shared technical leaf: it knows nothing
 * of newsletters, campaigns or subscriptions; callers hand it an already-
 * resolved recipient set and an already-rendered message and it does one thing
 * — submit the broadcast to the provider. Suppression and rendering happen
 * upstream (in `campaigns`), never here.
 */

/** A custom message header (name/value), e.g. RFC 8058 `List-Unsubscribe`. */
export interface EmailHeader {
  readonly name: string;
  readonly value: string;
}

/** A single resolved recipient. Rendering/personalization happens upstream. */
export interface EmailRecipient {
  /** The destination address (already validated/normalized by the caller). */
  readonly email: string;
  /**
   * Optional per-recipient custom headers. Each recipient may carry different
   * values — the campaigns send path uses this for a per-subscriber
   * `List-Unsubscribe` header (ADR-015). The gateway is a leaf: it transports
   * these verbatim and ascribes no meaning to them.
   */
  readonly headers?: readonly EmailHeader[];
}

/** The sender identity for a send — mapped from a newsletter's fields upstream. */
export interface SenderIdentity {
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyTo?: string | null;
}

/**
 * The business classification of a send — Postmark's own two categories, used
 * here as provider-neutral intent the caller declares:
 *  - `broadcast` — bulk newsletter/campaign mail (marketing);
 *  - `transactional` — one-off operational mail (subscribe confirmations,
 *    password-reset and magic-link emails).
 * The adapter maps a category to the provider's message stream **and** to which
 * server token signs the request (a transactional server may have its own token).
 */
export type MessageCategory = 'broadcast' | 'transactional';

/** A message body rendered in-app (`templates`) before it reaches the gateway. */
export interface RenderedMessage {
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody?: string | null;
}

/**
 * One logical broadcast: the same rendered message to a whole recipient set.
 * The gateway submits it to Postmark's Bulk API in a single call — the content
 * is defined once and the recipients ride along in the request (ADR-008). There
 * is no per-call recipient cap (only a 50 MB payload ceiling).
 */
export interface BulkMessage {
  readonly from: SenderIdentity;
  readonly content: RenderedMessage;
  readonly recipients: readonly EmailRecipient[];
  /**
   * Business classification of this send. The adapter maps it to the provider's
   * message stream and to the signing token; the caller declares intent, not a
   * provider stream name.
   */
  readonly category: MessageCategory;
  /** Optional correlation tag (e.g. a campaign id) echoed back on events. */
  readonly tag?: string;
}

/**
 * The provider's acknowledgment of a bulk submission. Postmark's Bulk API
 * (`POST /email/bulk`) is **asynchronous**: it accepts the whole broadcast in
 * one call and returns a request id. Per-recipient outcomes (delivered, bounced,
 * opened, clicked) arrive later as webhook events (ADR-008) — never in this
 * response. A submission the provider does not accept throws instead of
 * returning.
 */
export interface SendAcknowledgment {
  /** Postmark's bulk request id, for correlation/reconciliation. */
  readonly bulkRequestId: string;
  /** Normalized submission status; a non-accepted submission throws. */
  readonly status: 'accepted';
  /** Provider timestamp for when the broadcast was accepted (ISO 8601). */
  readonly submittedAt: string;
  /** How many recipients were submitted in the broadcast. */
  readonly recipientCount: number;
}

/**
 * Submit a rendered broadcast to a recipient set. Injected as an interface only
 * (ADR-003); `PostmarkDeliveryGateway` is the production binding and
 * `InMemoryDeliveryGateway` the DI-rebind test double.
 */
export interface DeliveryGateway {
  send(message: BulkMessage): Promise<SendAcknowledgment>;
}
