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
 * Any unrecognized payload yields no event rather than throwing, so an
 * unexpected or newly-added Postmark event never fails the receiver (a non-200
 * makes Postmark retry for hours). It is, however, **reported** rather than
 * dropped in silence: the parser returns the buckets it could not claim
 * alongside the events it could, and `campaigns` records them. Classification
 * stays here — one place decides what cablegram handles — while the writing
 * stays out, because this is a `shared/*` leaf with no repository.
 */

/** The provider-agnostic event kinds cablegram acts on. */
export type DeliveryEventType =
  | 'delivered'
  | 'hard-bounce'
  | 'soft-bounce'
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
 * A payload the parser could not turn into an event, reduced to a bucket key.
 *
 * The key is the *class* of payload, never the payload itself: one row per
 * distinct key keeps the record bounded no matter how many events arrive.
 */
export interface UnhandledProviderEvent {
  /**
   * The bucket: a bare `RecordType` for a type cablegram does not handle, a
   * `RecordType:Detail` pair when the type is handled but a sub-case is not
   * (`Bounce:NewBounceType`), or a sentinel for a body with no usable type.
   */
  readonly key: string;
  /** The payload as first seen, JSON-serialized and truncated. */
  readonly sample: string;
}

/** What one webhook body yielded: the events to apply, and what was dropped. */
export interface ParsedProviderEvents {
  readonly events: DeliveryEvent[];
  readonly unhandled: UnhandledProviderEvent[];
}

/** Bucket for a body that is not an object, or carries no usable `RecordType`. */
export const UNPARSEABLE_EVENT_KEY = '__unparseable';

/**
 * Bounce `Type` values that are dropped **on purpose**, and so must never be
 * reported as unhandled. Neither is a delivery failure: `AutoResponder` is an
 * out-of-office reply (the mail arrived, ADR-020) and `Subscribe` is a
 * subscription-management notice. Recording them would fill the report with
 * rows that mean "working as designed", which is exactly the noise that trains
 * people to stop reading it.
 */
const IGNORED_BOUNCE_TYPES = new Set(['AutoResponder', 'Subscribe']);

/** Keys are bounded so a hostile or malformed `RecordType` cannot bloat a row. */
const MAX_KEY_LENGTH = 100;

/** Enough of the payload to see its shape; not enough to be a copy of it. */
const MAX_SAMPLE_LENGTH = 1000;

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
 * Transient types are **not** here — they are classified separately below.
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

/**
 * Bounce types that are **transient** — the address may well accept mail later,
 * and Postmark does not deactivate it.
 *
 * These are normalized to `soft-bounce` rather than dropped (ADR-020). That is a
 * change of posture, and it rests on a fact worth stating: **Postmark already
 * retried before telling us.** When a mailbox provider defers a message,
 * Postmark re-attempts delivery on its own schedule; a `SoftBounce`/`Transient`
 * webhook fires only once Postmark has *given up*. So one of these events does
 * not mean "a hiccup" — it means a whole retry cycle failed.
 *
 * It is still not proof the mailbox is gone, which is why a single one changes
 * nothing on its own. Repetition is the signal (`subscriptions` counts them).
 *
 * `AutoResponder` is deliberately excluded from both sets: an out-of-office
 * reply is not a delivery failure at all — the mail arrived.
 */
const TRANSIENT_BOUNCE_TYPES = new Set([
  'Transient',
  'SoftBounce',
  'DnsError',
  'SMTPApiError',
  'InboundError',
  'TemplateRenderingFailed',
  'ChallengeVerification',
  'VirusNotification',
  'OpenRelayTest',
  'Unknown',
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

/**
 * The three outcomes for one payload. `ignored` is distinct from `unhandled` on
 * purpose: both produce no event, but only one of them is a surprise.
 */
type Classification =
  | { kind: 'event'; event: DeliveryEvent }
  | { kind: 'ignored' }
  | { kind: 'unhandled'; key: string };

const ignored: Classification = { kind: 'ignored' };

function unhandled(key: string): Classification {
  return { kind: 'unhandled', key: key.slice(0, MAX_KEY_LENGTH) };
}

/**
 * A type cablegram claims to handle, but this particular payload carried no
 * address — so there is nobody to apply it to. Reported rather than dropped:
 * "we handle Delivery" and "we applied this Delivery" are different claims, and
 * the gap between them is precisely what goes unnoticed otherwise.
 */
function addressed(
  type: DeliveryEventType,
  recordType: string,
  email: unknown,
  payload: Record<string, unknown>,
): Classification {
  const event = build(type, email, payload);
  return event === null
    ? unhandled(`${recordType}:__no-address`)
    : { kind: 'event', event };
}

function classifyOne(payload: unknown): Classification {
  if (!isRecord(payload)) return unhandled(UNPARSEABLE_EVENT_KEY);

  const recordType = str(payload.RecordType);
  if (recordType === null) return unhandled(UNPARSEABLE_EVENT_KEY);

  switch (recordType) {
    case 'Delivery':
      return addressed('delivered', recordType, payload.Recipient, payload);
    case 'Bounce': {
      // Permanence, not a single literal — see PERMANENT_BOUNCE_TYPES.
      const type = str(payload.Type);
      if (type === null) return unhandled('Bounce:__no-type');
      if (PERMANENT_BOUNCE_TYPES.has(type)) {
        return addressed('hard-bounce', recordType, payload.Email, payload);
      }
      if (TRANSIENT_BOUNCE_TYPES.has(type)) {
        return addressed('soft-bounce', recordType, payload.Email, payload);
      }
      if (IGNORED_BOUNCE_TYPES.has(type)) return ignored;
      // A bounce type in neither table is the exact case worth catching: both
      // sets are pinned to Postmark's published table, so a new entry here
      // means the table moved and we are silently discarding real failures.
      return unhandled(`Bounce:${type}`);
    }
    case 'SpamComplaint':
      return addressed('spam-complaint', recordType, payload.Email, payload);
    case 'Open':
      return addressed('open', recordType, payload.Recipient, payload);
    case 'Click':
      return addressed('click', recordType, payload.Recipient, payload);
    default:
      return unhandled(recordType);
  }
}

/** A bounded, JSON-ish rendering of a payload, safe to store on a document. */
function sampleOf(payload: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? String(payload);
  } catch {
    // A body that cannot be serialized (circular, a BigInt) is itself the
    // finding; the type name is enough to act on.
    json = `[unserializable ${typeof payload}]`;
  }
  return json.length <= MAX_SAMPLE_LENGTH ? json : `${json.slice(0, MAX_SAMPLE_LENGTH - 1)}…`;
}

/**
 * Normalize a raw Postmark webhook body into provider-agnostic events, and
 * report whatever could not be normalized. Postmark sends a single object per
 * request; an array is also accepted defensively.
 *
 * Nothing here throws — the receiver must always 200 (ADR-008) — but nothing
 * vanishes either: a payload that yields no event either lands in `unhandled`
 * or is on the deliberate ignore list.
 */
export function parseProviderEvent(rawWebhookPayload: unknown): ParsedProviderEvents {
  const items = Array.isArray(rawWebhookPayload) ? rawWebhookPayload : [rawWebhookPayload];
  const events: DeliveryEvent[] = [];
  const unclaimed: UnhandledProviderEvent[] = [];

  for (const item of items) {
    const result = classifyOne(item);
    if (result.kind === 'event') events.push(result.event);
    else if (result.kind === 'unhandled') {
      unclaimed.push({ key: result.key, sample: sampleOf(item) });
    }
  }

  return { events, unhandled: unclaimed };
}
