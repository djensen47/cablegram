import { describe, expect, it } from 'vitest';
import { parseProviderEvent, UNPARSEABLE_EVENT_KEY } from './index.js';

// Fixtures are the real Postmark webhook payload shapes (fields pinned against
// the live docs), trimmed to the fields cablegram reads.
const deliveryPayload = {
  RecordType: 'Delivery',
  MessageStream: 'broadcast',
  MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
  Recipient: 'john@example.com',
  DeliveredAt: '2019-11-05T16:33:54.9070259Z',
  Tag: 'campaign-42',
};

const hardBouncePayload = {
  RecordType: 'Bounce',
  Type: 'HardBounce',
  TypeCode: 1,
  MessageID: 'bbb',
  Email: 'bounce@example.com',
  BouncedAt: '2019-11-05T16:33:54.9070259Z',
  Tag: 'campaign-42',
};

const softBouncePayload = {
  RecordType: 'Bounce',
  Type: 'SoftBounce',
  TypeCode: 4096,
  Email: 'soft@example.com',
  BouncedAt: '2019-11-05T16:33:54Z',
};

const spamComplaintPayload = {
  RecordType: 'SpamComplaint',
  Type: 'SpamComplaint',
  TypeCode: 512,
  MessageID: 'ccc',
  Email: 'spam@example.com',
  BouncedAt: '2019-11-05T16:33:54.9070259Z',
};

const openPayload = {
  RecordType: 'Open',
  MessageID: 'ddd',
  Recipient: 'opener@example.com',
  ReceivedAt: '2019-11-05T16:33:54.9070259Z',
  FirstOpen: true,
};

const clickPayload = {
  RecordType: 'Click',
  MessageID: 'eee',
  Recipient: 'clicker@example.com',
  ReceivedAt: '2017-10-25T15:21:11.9065619Z',
  OriginalLink: 'https://example.com',
};

describe('parseProviderEvent', () => {
  it('normalizes a Delivery webhook', () => {
    const [event] = parseProviderEvent(deliveryPayload).events;
    expect(event).toEqual({
      type: 'delivered',
      email: 'john@example.com',
      messageId: '883953f4-6105-42a2-a16a-77a8eac79483',
      occurredAt: new Date('2019-11-05T16:33:54.9070259Z'),
      tag: 'campaign-42',
      firstEngagement: null,
    });
  });

  it('normalizes a hard Bounce', () => {
    const [event] = parseProviderEvent(hardBouncePayload).events;
    expect(event).toMatchObject({ type: 'hard-bounce', email: 'bounce@example.com', messageId: 'bbb' });
    expect(event!.occurredAt).toEqual(new Date('2019-11-05T16:33:54.9070259Z'));
  });

  it('normalizes a soft/transient bounce (and must never suppress the address)', () => {
    const [event] = parseProviderEvent(softBouncePayload).events;
    expect(event?.type).toBe('soft-bounce');
  });

  it('normalizes a SpamComplaint', () => {
    const [event] = parseProviderEvent(spamComplaintPayload).events;
    expect(event).toMatchObject({ type: 'spam-complaint', email: 'spam@example.com', messageId: 'ccc' });
  });

  it('normalizes an Open', () => {
    const [event] = parseProviderEvent(openPayload).events;
    expect(event).toMatchObject({ type: 'open', email: 'opener@example.com', messageId: 'ddd' });
  });

  it('normalizes a Click', () => {
    const [event] = parseProviderEvent(clickPayload).events;
    expect(event).toMatchObject({ type: 'click', email: 'clicker@example.com', messageId: 'eee' });
    expect(event!.occurredAt).toEqual(new Date('2017-10-25T15:21:11.9065619Z'));
  });

  it('emits no event for an unrecognized RecordType', () => {
    const parsed = parseProviderEvent({ RecordType: 'SubscriptionChange', Recipient: 'x@example.com' });
    expect(parsed.events).toEqual([]);
  });

  it('emits no event for malformed / non-object payloads, without throwing', () => {
    expect(parseProviderEvent(null).events).toEqual([]);
    expect(parseProviderEvent('not json').events).toEqual([]);
    expect(parseProviderEvent({ RecordType: 'Delivery' }).events).toEqual([]); // no Recipient
  });

  it('nulls an unparseable timestamp rather than emitting an invalid Date', () => {
    const [event] = parseProviderEvent({ ...deliveryPayload, DeliveredAt: 'not-a-date' }).events;
    expect(event!.occurredAt).toBeNull();
  });

  it('accepts an array of events defensively', () => {
    const events = parseProviderEvent([deliveryPayload, spamComplaintPayload, softBouncePayload]).events;
    expect(events.map((e) => e.type)).toEqual(['delivered', 'spam-complaint', 'soft-bounce']);
  });
});

// Regression (ADR-019): the previous implementation matched only the literal
// 'HardBounce' and silently discarded every other bounce type — including seven
// Postmark classifies as PERMANENT and has already deactivated. Those addresses
// stayed un-suppressed and were re-sent on every subsequent campaign.
describe('bounce classification', () => {
  const bounce = (type: string): unknown => ({
    RecordType: 'Bounce',
    Type: type,
    Email: 'john@example.com',
    MessageID: 'm-1',
    BouncedAt: '2019-11-05T16:33:54Z',
    Tag: 'campaign-42',
  });

  it.each(['HardBounce', 'BadEmailAddress', 'Blocked', 'DMARCPolicy', 'SpamNotification'])(
    'treats %s as permanent',
    (type) => {
      const [event] = parseProviderEvent(bounce(type)).events;
      expect(event?.type).toBe('hard-bounce');
    },
  );

  it.each(['Transient', 'SoftBounce', 'DnsError', 'SMTPApiError'])(
    'normalizes %s to soft-bounce',
    (type) => {
      // No longer dropped (ADR-020). Postmark retries internally before
      // reporting one, so a soft bounce means a whole retry cycle already
      // failed — worth counting, though one is not proof the mailbox is gone.
      const [event] = parseProviderEvent(bounce(type)).events;
      expect(event?.type).toBe('soft-bounce');
    },
  );

  it('still drops AutoResponder — an out-of-office reply is not a failure', () => {
    expect(parseProviderEvent(bounce('AutoResponder')).events).toEqual([]);
  });

  it('carries FirstOpen through as firstEngagement on an Open', () => {
    const [event] = parseProviderEvent({
      RecordType: 'Open',
      FirstOpen: true,
      Recipient: 'john@example.com',
      MessageID: 'm-1',
      ReceivedAt: '2019-11-05T16:33:54Z',
      Tag: 'campaign-42',
    }).events;
    expect(event?.firstEngagement).toBe(true);
  });
});

/**
 * The reporting half (issue #29). Every payload that yields no event must be
 * accounted for: either it is on the deliberate ignore list, or it comes back
 * as an `unhandled` bucket. "Nothing happened and nobody can tell" is the bug.
 */
describe('unhandled classification', () => {
  const keys = (payload: unknown): string[] =>
    parseProviderEvent(payload).unhandled.map((u) => u.key);

  it('buckets an unrecognized RecordType under its own name', () => {
    expect(keys({ RecordType: 'SubscriptionChange', Recipient: 'x@example.com' })).toEqual([
      'SubscriptionChange',
    ]);
  });

  it('buckets non-object and type-less bodies under a sentinel', () => {
    expect(keys(null)).toEqual([UNPARSEABLE_EVENT_KEY]);
    expect(keys('not json')).toEqual([UNPARSEABLE_EVENT_KEY]);
    expect(keys(42)).toEqual([UNPARSEABLE_EVENT_KEY]);
    expect(keys({ Recipient: 'x@example.com' })).toEqual([UNPARSEABLE_EVENT_KEY]);
    expect(keys({ RecordType: 42 })).toEqual([UNPARSEABLE_EVENT_KEY]);
  });

  it('reports a bounce type in neither table, keyed by the type', () => {
    // The case this is really for: Postmark's published type table moves and we
    // start discarding real failures under a name nobody has seen before.
    expect(keys({ RecordType: 'Bounce', Type: 'NewFangledBounce', Email: 'a@b.example' })).toEqual([
      'Bounce:NewFangledBounce',
    ]);
    expect(keys({ RecordType: 'Bounce', Email: 'a@b.example' })).toEqual(['Bounce:__no-type']);
  });

  it('reports a handled type that carried no address', () => {
    // "We handle Delivery" and "we applied this Delivery" are different claims.
    expect(keys({ RecordType: 'Delivery' })).toEqual(['Delivery:__no-address']);
    expect(keys({ RecordType: 'Bounce', Type: 'HardBounce' })).toEqual(['Bounce:__no-address']);
  });

  it('reports NOTHING for the deliberately-ignored bounce types', () => {
    // Not failures, so not surprises — recording them would fill the report
    // with rows that mean "working as designed" (ADR-020).
    for (const type of ['AutoResponder', 'Subscribe']) {
      const parsed = parseProviderEvent({ RecordType: 'Bounce', Type: type, Email: 'a@b.example' });
      expect(parsed.events).toEqual([]);
      expect(parsed.unhandled).toEqual([]);
    }
  });

  it('reports nothing for payloads it fully handles', () => {
    expect(parseProviderEvent(deliveryPayload).unhandled).toEqual([]);
    expect(parseProviderEvent(hardBouncePayload).unhandled).toEqual([]);
    expect(parseProviderEvent(openPayload).unhandled).toEqual([]);
  });

  it('carries a truncated JSON sample of the payload', () => {
    const [item] = parseProviderEvent({ RecordType: 'Weird', Extra: 'x'.repeat(5000) }).unhandled;
    expect(item!.sample.startsWith('{"RecordType":"Weird"')).toBe(true);
    // Bounded, so one absurd payload cannot bloat the row it lands in.
    expect(item!.sample.length).toBeLessThanOrEqual(1000);
  });

  it('bounds the key so a hostile RecordType cannot bloat the row', () => {
    const [item] = parseProviderEvent({ RecordType: 'A'.repeat(5000) }).unhandled;
    expect(item!.key.length).toBe(100);
  });

  it('separates handled and unhandled items in one defensive array', () => {
    const parsed = parseProviderEvent([deliveryPayload, { RecordType: 'SubscriptionChange' }]);
    expect(parsed.events.map((e) => e.type)).toEqual(['delivered']);
    expect(parsed.unhandled.map((u) => u.key)).toEqual(['SubscriptionChange']);
  });
});
