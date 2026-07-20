/**
 * Provider webhook normalization (ADR-008). Postmark POSTs one event object per
 * request, each tagged with a `RecordType`; `parseProviderEvent` maps the shapes
 * cablegram cares about onto provider-agnostic `DeliveryEvent`s. Field names are
 * pinned against the live Postmark webhook docs, not memory:
 *
 *   - Delivery        RecordType "Delivery",       Recipient, MessageID, DeliveredAt
 *   - Bounce          RecordType "Bounce",   Type "HardBounce", Email, MessageID, BouncedAt
 *   - Spam complaint  RecordType "SpamComplaint",  Email,     MessageID, BouncedAt
 *   - Open            RecordType "Open",           Recipient, MessageID, ReceivedAt
 *   - Click           RecordType "Click",          Recipient, MessageID, ReceivedAt
 *
 * Only a hard bounce is normalized off the Bounce webhook — soft/transient
 * bounces are intentionally dropped (they must not suppress an address). Spam
 * complaints arrive on their own `RecordType`, not the bounce hook. Any
 * unrecognized payload yields an empty array rather than throwing, so an
 * unexpected or newly-added Postmark event never fails the receiver.
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
}

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
  };
}

function normalizeOne(payload: unknown): DeliveryEvent | null {
  if (!isRecord(payload)) return null;

  switch (payload.RecordType) {
    case 'Delivery':
      return build('delivered', payload.Recipient, payload);
    case 'Bounce':
      // Only a hard bounce suppresses; soft/transient bounces are dropped.
      return payload.Type === 'HardBounce' ? build('hard-bounce', payload.Email, payload) : null;
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
