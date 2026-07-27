/**
 * Provider webhook normalization (ADR-008). Postmark POSTs **one event object
 * per request** — one recipient, never a batch — each tagged with a
 * `RecordType`. `parseProviderEvent` maps the shapes cablegram cares about onto
 * provider-agnostic `DeliveryEvent`s. Field names are pinned against the live
 * Postmark webhook docs, not memory:
 *
 *   - Delivery        RecordType "Delivery",      Recipient, MessageID, DeliveredAt
 *   - Bounce          RecordType "Bounce",        Email,     MessageID, BouncedAt, Type, TypeCode
 *   - Spam complaint  RecordType "SpamComplaint", Email,     MessageID, BouncedAt
 *   - Open            RecordType "Open",          Recipient, MessageID, ReceivedAt, FirstOpen
 *   - Click           RecordType "Click",         Recipient, MessageID, ReceivedAt
 *
 * Note the address field differs by type: `Recipient` for delivery/open/click,
 * `Email` for bounce/complaint. Every type carries `Tag`, which is the campaign
 * id echoed back from the send — the only correlation handle we get.
 *
 * Any unrecognized payload yields an empty array rather than throwing, so an
 * unexpected or newly-added Postmark event never fails the receiver (a non-200
 * makes Postmark retry for hours).
 */

/** The provider-agnostic event kinds cablegram acts on. */
export type DeliveryEventType =
  | 'delivered'
  | 'hard-bounce'
  | 'spam-complaint'
  | 'open'
  | 'click';

/** A normalized delivery event. `campaigns` records these onto its aggregates. */
export interface DeliveryEvent {
  readonly type: DeliveryEventType;
  /** The affected recipient address. */
  readonly email: string;
  /** Provider message id for correlation, or `null` if absent. */
  readonly messageId: string | null;
  /** When the event occurred at the provider, or `null` if unparseable. */
  readonly occurredAt: Date | null;
  /** The send's correlation tag (e.g. a campaign id), or `null` if absent. */
  readonly tag: string | null;
  /**
   * For `open`/`click`: whether the provider flagged this as the recipient's
   * **first**. `null` for every other type, and for a provider that omits it.
   * Postmark sends `FirstOpen` on the open webhook.
   */
  readonly firstEngagement: boolean | null;
}

/**
 * Postmark bounce `Type` values that are **permanent** — the address will never
 * accept mail, and Postmark itself deactivates it. Pinned against the live
 * Bounce API type table.
 *
 * This set is the fix for a real bug: the previous implementation matched only
 * the literal string `HardBounce` and dropped every other bounce type, which
 * silently discarded seven permanent failures. `BadEmailAddress`, `Blocked` and
 * `DMARCPolicy` in particular are as final as a hard bounce, so an address that
 * produced one stayed un-suppressed and was re-sent on every subsequent
 * campaign — burning the sending domain's reputation on mail that cannot land.
 *
 * Transient types (`Transient`, `SoftBounce`, `DnsError`, `AutoResponder`,
 * `SMTPApiError`, …) are deliberately **not** here: a full mailbox or a
 * greylisting server is not a reason to stop mailing someone. Detecting a
 * *pattern* of soft bounces needs a counter, which is its own change.
 */
const PERMANENT_BOUNCE_TYPES = new Set([
  'HardBounce',
  'BadEmailAddress',
  'Blocked',
  'DMARCPolicy',
  'SpamNotification',
  'AddressChange',
  'Unconfirmed',
  'ManuallyDeactivated',
]);

/** Shape-narrowing helpers over the untrusted webhook body. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function date(value: unknown): Date | null {
  const s = str(value);
  if (s === null) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Build an event, requiring a usable email; returns `null` if none is present. */
function build(
  type: DeliveryEventType,
  email: unknown,
  payload: Record<string, unknown>,
): DeliveryEvent | null {
  const address = str(email);
  if (address === null) return null;
  return {
    type,
    email: address,
    messageId: str(payload.MessageID),
    occurredAt: date(payload.DeliveredAt ?? payload.BouncedAt ?? payload.ReceivedAt),
    tag: str(payload.Tag),
    firstEngagement: type === 'open' || type === 'click' ? bool(payload.FirstOpen) : null,
  };
}

function normalizeOne(payload: unknown): DeliveryEvent | null {
  if (!isRecord(payload)) return null;

  switch (payload.RecordType) {
    case 'Delivery':
      return build('delivered', payload.Recipient, payload);
    case 'Bounce': {
      // Permanence, not a single literal — see PERMANENT_BOUNCE_TYPES.
      const type = str(payload.Type);
      return type !== null && PERMANENT_BOUNCE_TYPES.has(type)
        ? build('hard-bounce', payload.Email, payload)
        : null;
    }
    case 'SpamComplaint':
      return build('spam-complaint', payload.Email, payload);
    case 'Open':
      return build('open', payload.Recipient, payload);
    case 'Click':
      return build('click', payload.Recipient, payload);
    default:
      return null;
  }
}

/**
 * Normalize a raw Postmark webhook body into provider-agnostic events. Postmark
 * sends a single object per request; an array is also accepted defensively.
 * Unrecognized or malformed payloads contribute nothing (no throw).
 */
export function parseProviderEvent(rawWebhookPayload: unknown): DeliveryEvent[] {
  const items = Array.isArray(rawWebhookPayload) ? rawWebhookPayload : [rawWebhookPayload];
  const events: DeliveryEvent[] = [];
  for (const item of items) {
    const event = normalizeOne(item);
    if (event !== null) events.push(event);
  }
  return events;
}
