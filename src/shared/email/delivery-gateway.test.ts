import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../di/index.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  PostmarkDeliveryGateway,
  type BulkMessage,
  type DeliveryGateway,
} from './index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 'server-token',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

const message: BulkMessage = {
  from: { fromName: 'Dispatch Editors', fromEmail: 'editors@dispatch.example', replyTo: 'replies@dispatch.example' },
  content: { subject: 'Issue #1', htmlBody: '<h1>Hello</h1>', textBody: 'Hello' },
  recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
  tag: 'campaign-42',
};

/** A single captured request's parsed JSON batch body plus its headers. */
interface CapturedCall {
  body: Record<string, unknown>[];
  headers: Record<string, string>;
}

function stubFetch(): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
    calls.push({ body, headers: init?.headers as Record<string, string> });
    // Postmark returns HTTP 200 with one result per message in the batch.
    const results = body.map((m, i) => ({
      ErrorCode: 0,
      Message: 'OK',
      MessageID: `mid-${i}`,
      To: m.To,
    }));
    return new Response(JSON.stringify(results), { status: 200 });
  });
  return { calls };
}

describe('PostmarkDeliveryGateway.send', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a recipient set to one Postmark batch message per recipient', async () => {
    const { calls } = stubFetch();
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 'server-token', webhookSecret: 's' } } as never);

    const results = await gateway.send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['X-Postmark-Server-Token']).toBe('server-token');
    const batch = calls[0]!.body;
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({
      From: 'Dispatch Editors <editors@dispatch.example>',
      To: 'a@example.com',
      ReplyTo: 'replies@dispatch.example',
      Subject: 'Issue #1',
      HtmlBody: '<h1>Hello</h1>',
      TextBody: 'Hello',
      MessageStream: 'broadcast',
      Tag: 'campaign-42',
    });
    expect(batch[1]!.To).toBe('b@example.com');

    expect(results).toEqual([
      { email: 'a@example.com', messageId: 'mid-0', accepted: true, errorCode: 0, message: 'OK' },
      { email: 'b@example.com', messageId: 'mid-1', accepted: true, errorCode: 0, message: 'OK' },
    ]);
  });

  it('omits ReplyTo/TextBody/Tag when not provided and honors an explicit stream', async () => {
    const { calls } = stubFetch();
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 't', webhookSecret: 's' } } as never);

    await gateway.send({
      from: { fromName: 'Solo', fromEmail: 'solo@example.com' },
      content: { subject: 'Hi', htmlBody: '<p>x</p>' },
      recipients: [{ email: 'c@example.com' }],
      messageStream: 'outbound',
    });

    const msg = calls[0]!.body[0]!;
    expect(msg).not.toHaveProperty('ReplyTo');
    expect(msg).not.toHaveProperty('TextBody');
    expect(msg).not.toHaveProperty('Tag');
    expect(msg.MessageStream).toBe('outbound');
  });

  it('splits a set larger than the 500-per-call cap across multiple batch calls', async () => {
    const { calls } = stubFetch();
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 't', webhookSecret: 's' } } as never);

    const recipients = Array.from({ length: 501 }, (_, i) => ({ email: `r${i}@example.com` }));
    const results = await gateway.send({ ...message, recipients, tag: undefined });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toHaveLength(500);
    expect(calls[1]!.body).toHaveLength(1);
    expect(results).toHaveLength(501);
  });

  it('returns immediately without calling the provider for an empty recipient set', async () => {
    const { calls } = stubFetch();
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 't', webhookSecret: 's' } } as never);

    const results = await gateway.send({ ...message, recipients: [] });

    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws EmailDeliveryError on a non-2xx provider response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad token', { status: 401 }));
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 't', webhookSecret: 's' } } as never);

    await expect(gateway.send(message)).rejects.toThrow(/Postmark batch send failed \(HTTP 401\)/);
  });

  it('marks a per-message rejection as not accepted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { ErrorCode: 0, Message: 'OK', MessageID: 'ok-1', To: 'a@example.com' },
          { ErrorCode: 300, Message: 'Invalid email address', To: 'b@example.com' },
        ]),
        { status: 200 },
      ),
    );
    const gateway = new PostmarkDeliveryGateway({ postmark: { serverToken: 't', webhookSecret: 's' } } as never);

    const results = await gateway.send(message);
    expect(results[0]).toMatchObject({ accepted: true, messageId: 'ok-1' });
    expect(results[1]).toMatchObject({ accepted: false, messageId: null, errorCode: 300 });
  });
});

describe('InMemoryDeliveryGateway', () => {
  it('records sends and reports every recipient accepted', async () => {
    const gateway = new InMemoryDeliveryGateway();
    const results = await gateway.send(message);

    expect(gateway.sent).toEqual([message]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.accepted)).toBe(true);
  });
});

describe('DI wiring', () => {
  let container: Container;
  beforeEach(() => {
    container = buildContainer(env);
  });

  it('binds the Postmark gateway by default', () => {
    expect(container.get<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway)).toBeInstanceOf(
      PostmarkDeliveryGateway,
    );
  });

  it('is rebindable to the in-memory double', async () => {
    container.rebind(EMAIL_TYPES.DeliveryGateway).to(InMemoryDeliveryGateway);
    const gateway = container.get<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway);
    expect(gateway).toBeInstanceOf(InMemoryDeliveryGateway);

    await gateway.send(message);
    expect((gateway as InMemoryDeliveryGateway).sent).toHaveLength(1);
  });
});
