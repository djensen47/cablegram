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
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 'server-token',
  POSTMARK_WEBHOOK_SECRET: 's',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
} as NodeJS.ProcessEnv;

/** A gateway wired with the two tokens the config resolves (fallback applied). */
function gatewayWith(serverToken: string, transactionalServerToken = serverToken) {
  return new PostmarkDeliveryGateway({
    postmark: { serverToken, transactionalServerToken, webhookSecret: 's' },
  } as never);
}

const message: BulkMessage = {
  from: { fromName: 'Dispatch Editors', fromEmail: 'editors@dispatch.example', replyTo: 'replies@dispatch.example' },
  content: { subject: 'Issue #1', htmlBody: '<h1>Hello</h1>', textBody: 'Hello' },
  recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
  category: 'broadcast',
  tag: 'campaign-42',
};

/** A captured `/email/bulk` request: its URL, parsed JSON body, and headers. */
interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Stub `fetch` to record calls and return an accepted bulk acknowledgment. */
function stubBulk(id = 'bulk-req-1'): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    return new Response(
      JSON.stringify({ ID: id, Status: 'Accepted', SubmittedAt: '2026-07-20T00:00:00.000Z' }),
      { status: 200 },
    );
  });
  return { calls };
}

describe('PostmarkDeliveryGateway.send', () => {
  afterEach(() => vi.restoreAllMocks());

  it('submits one /email/bulk request: content once + a Messages array of recipients', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('server-token');

    const ack = await gateway.send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/email/bulk');
    expect(calls[0]!.headers['X-Postmark-Server-Token']).toBe('server-token');

    const req = calls[0]!.body;
    expect(req).toMatchObject({
      From: 'Dispatch Editors <editors@dispatch.example>',
      ReplyTo: 'replies@dispatch.example',
      Subject: 'Issue #1',
      HtmlBody: '<h1>Hello</h1>',
      TextBody: 'Hello',
      MessageStream: 'broadcast',
      Tag: 'campaign-42',
    });
    expect(req.Messages).toEqual([{ To: 'a@example.com' }, { To: 'b@example.com' }]);

    expect(ack).toEqual({
      bulkRequestId: 'bulk-req-1',
      status: 'accepted',
      submittedAt: '2026-07-20T00:00:00.000Z',
      recipientCount: 2,
    });
  });

  it('maps per-recipient headers onto each bulk Messages entry (ADR-015)', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('t');

    await gateway.send({
      ...message,
      recipients: [
        { email: 'a@example.com', headers: [{ name: 'List-Unsubscribe', value: '<https://api.example/u?a>' }] },
        { email: 'b@example.com' },
      ],
    });

    expect(calls[0]!.body.Messages).toEqual([
      { To: 'a@example.com', Headers: [{ Name: 'List-Unsubscribe', Value: '<https://api.example/u?a>' }] },
      // No headers → no Headers key, unchanged from the base shape.
      { To: 'b@example.com' },
    ]);
  });

  it('omits ReplyTo/TextBody/Tag when not provided and maps a transactional category', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('t');

    await gateway.send({
      from: { fromName: 'Solo', fromEmail: 'solo@example.com' },
      content: { subject: 'Hi', htmlBody: '<p>x</p>' },
      recipients: [{ email: 'c@example.com' }],
      category: 'transactional',
    });

    const req = calls[0]!.body;
    expect(req).not.toHaveProperty('ReplyTo');
    expect(req).not.toHaveProperty('TextBody');
    expect(req).not.toHaveProperty('Tag');
    // A transactional category maps to Postmark's `outbound` stream.
    expect(req.MessageStream).toBe('outbound');
    expect(req.Messages).toEqual([{ To: 'c@example.com' }]);
  });

  it('signs broadcast with the broadcast token and transactional with the transactional token', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('broadcast-token', 'txn-token');

    await gateway.send({ ...message, category: 'broadcast' });
    await gateway.send({ ...message, category: 'transactional' });

    expect(calls[0]!.headers['X-Postmark-Server-Token']).toBe('broadcast-token');
    expect(calls[0]!.body.MessageStream).toBe('broadcast');
    expect(calls[1]!.headers['X-Postmark-Server-Token']).toBe('txn-token');
    expect(calls[1]!.body.MessageStream).toBe('outbound');
  });

  it('falls transactional back to the broadcast token when only one is configured', async () => {
    const { calls } = stubBulk();
    // The config resolves an unset transactional token to the broadcast token.
    const gateway = gatewayWith('only-token');

    await gateway.send({ ...message, category: 'transactional' });

    expect(calls[0]!.headers['X-Postmark-Server-Token']).toBe('only-token');
  });

  it('sends any number of recipients in ONE bulk call (no 500-cap splitting)', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('t');

    const recipients = Array.from({ length: 5000 }, (_, i) => ({ email: `r${i}@example.com` }));
    const ack = await gateway.send({ ...message, recipients, tag: undefined });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.Messages as unknown[]).toHaveLength(5000);
    expect(ack.recipientCount).toBe(5000);
  });

  it('does not call the provider for an empty recipient set', async () => {
    const { calls } = stubBulk();
    const gateway = gatewayWith('t');

    const ack = await gateway.send({ ...message, recipients: [] });

    expect(calls).toHaveLength(0);
    expect(ack.recipientCount).toBe(0);
    expect(ack.bulkRequestId).toBe('');
  });

  it('throws EmailDeliveryError on a non-2xx provider response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad token', { status: 401 }));
    const gateway = gatewayWith('t');

    await expect(gateway.send(message)).rejects.toThrow(/Postmark bulk send failed \(HTTP 401\)/);
  });

  it('throws when the provider returns 200 but does not accept the submission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ Status: 'Failed', Message: 'nope' }), { status: 200 }),
    );
    const gateway = gatewayWith('t');

    await expect(gateway.send(message)).rejects.toThrow(/not accepted/);
  });
});

describe('InMemoryDeliveryGateway', () => {
  it('records sends and returns an accepted acknowledgment', async () => {
    const gateway = new InMemoryDeliveryGateway();
    const ack = await gateway.send(message);

    expect(gateway.sent).toEqual([message]);
    expect(ack.status).toBe('accepted');
    expect(ack.recipientCount).toBe(2);
    expect(ack.bulkRequestId).toBe('in-memory-1');
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
