/**
 * The email delivery gateway — cablegram's anti-corruption layer over the
 * email provider (Postmark, ADR-008). A shared technical leaf: it knows nothing
 * of newsletters, campaigns or subscriptions; callers hand it an already-
 * resolved recipient set and an already-rendered message and it does one thing
 * — hand the batch to the provider. Suppression and rendering happen upstream
 * (in `campaigns`), never here.
 */

/** A single resolved recipient. Rendering/personalization happens upstream. */
export interface EmailRecipient {
  /** The destination address (already validated/normalized by the caller). */
  readonly email: string;
}

/** The sender identity for a send — mapped from a newsletter's fields upstream. */
export interface SenderIdentity {
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyTo?: string | null;
}

/** A message body rendered in-app (`templates`) before it reaches the gateway. */
export interface RenderedMessage {
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody?: string | null;
}

/**
 * One logical broadcast: the same rendered message to a whole recipient set.
 * The gateway fans this out to the provider; any per-call size limit and the
 * splitting it forces are an internal detail of the implementation (ADR-008).
 */
export interface BulkMessage {
  readonly from: SenderIdentity;
  readonly content: RenderedMessage;
  readonly recipients: readonly EmailRecipient[];
  /**
   * Provider message stream. Newsletters are broadcasts, so this defaults to
   * `"broadcast"` in the implementation when omitted.
   */
  readonly messageStream?: string;
  /** Optional correlation tag (e.g. a campaign id) echoed back on events. */
  readonly tag?: string;
}

/** The per-recipient outcome of a send, normalized off the provider response. */
export interface DeliveryResult {
  readonly email: string;
  /** Provider message id when accepted; `null` when the message was rejected. */
  readonly messageId: string | null;
  /** `true` when the provider accepted the message for delivery. */
  readonly accepted: boolean;
  /** Provider error code (`0` = success) and its human-readable message. */
  readonly errorCode: number;
  readonly message: string;
}

/**
 * Send a rendered message to a recipient set. Injected as an interface only
 * (ADR-003); `PostmarkDeliveryGateway` is the production binding and
 * `InMemoryDeliveryGateway` the DI-rebind test double.
 */
export interface DeliveryGateway {
  send(message: BulkMessage): Promise<DeliveryResult[]>;
}
