import { describe, expect, it } from 'vitest';
import { parseProviderEvent } from './index.js';

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
    const [event] = parseProviderEvent(deliveryPayload);
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
    const [event] = parseProviderEvent(hardBouncePayload);
    expect(event).toMatchObject({ type: 'hard-bounce', email: 'bounce@example.com', messageId: 'bbb' });
    expect(event!.occurredAt).toEqual(new Date('2019-11-05T16:33:54.9070259Z'));
  });

  it('drops a soft/transient bounce (must not suppress the address)', () => {
    expect(parseProviderEvent(softBouncePayload)).toEqual([]);
  });

  it('normalizes a SpamComplaint', () => {
    const [event] = parseProviderEvent(spamComplaintPayload);
    expect(event).toMatchObject({ type: 'spam-complaint', email: 'spam@example.com', messageId: 'ccc' });
  });

  it('normalizes an Open', () => {
    const [event] = parseProviderEvent(openPayload);
    expect(event).toMatchObject({ type: 'open', email: 'opener@example.com', messageId: 'ddd' });
  });

  it('normalizes a Click', () => {
    const [event] = parseProviderEvent(clickPayload);
    expect(event).toMatchObject({ type: 'click', email: 'clicker@example.com', messageId: 'eee' });
    expect(event!.occurredAt).toEqual(new Date('2017-10-25T15:21:11.9065619Z'));
  });

  it('ignores an unrecognized RecordType', () => {
    expect(parseProviderEvent({ RecordType: 'SubscriptionChange', Recipient: 'x@example.com' })).toEqual([]);
  });

  it('ignores malformed / non-object payloads without throwing', () => {
    expect(parseProviderEvent(null)).toEqual([]);
    expect(parseProviderEvent('not json')).toEqual([]);
    expect(parseProviderEvent({ RecordType: 'Delivery' })).toEqual([]); // no Recipient
  });

  it('nulls an unparseable timestamp rather than emitting an invalid Date', () => {
    const [event] = parseProviderEvent({ ...deliveryPayload, DeliveredAt: 'not-a-date' });
    expect(event!.occurredAt).toBeNull();
  });

  it('accepts an array of events defensively', () => {
    const events = parseProviderEvent([deliveryPayload, spamComplaintPayload, softBouncePayload]);
    expect(events.map((e) => e.type)).toEqual(['delivered', 'spam-complaint']);
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
      const [event] = parseProviderEvent(bounce(type));
      expect(event?.type).toBe('hard-bounce');
    },
  );

  it.each(['Transient', 'SoftBounce', 'DnsError', 'AutoResponder', 'SMTPApiError'])(
    'drops %s as transient',
    (type) => {
      // A full mailbox or a greylisting server is not a reason to suppress.
      expect(parseProviderEvent(bounce(type))).toEqual([]);
    },
  );

  it('carries FirstOpen through as firstEngagement on an Open', () => {
    const [event] = parseProviderEvent({
      RecordType: 'Open',
      FirstOpen: true,
      Recipient: 'john@example.com',
      MessageID: 'm-1',
      ReceivedAt: '2019-11-05T16:33:54Z',
      Tag: 'campaign-42',
    });
    expect(event?.firstEngagement).toBe(true);
  });
});
