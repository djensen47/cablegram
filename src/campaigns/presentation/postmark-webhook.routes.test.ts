import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { createApp } from '../../app.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from '../../shared/email/index.js';
import { NEWSLETTER_TYPES, InMemoryNewsletterRepository, CreateNewsletter } from '../../newsletters/index.js';
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository, Subscribe } from '../../subscriptions/index.js';
import { DELIVERABILITY_TYPES, InMemorySuppressionRepository } from '../../deliverability/index.js';
import { TEMPLATE_TYPES, InMemoryTemplateRepository, CreateTemplate } from '../../templates/index.js';
import { CAMPAIGN_TYPES, InMemoryCampaignRepository, InMemorySendRepository,
  InMemoryRecipientOutcomeRepository,
  InMemoryUnhandledEventRepository } from '../index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';

// This suite needs a known webhook secret for the Basic-Auth assertions; the
// JWT secret stays the default so `bearerHeaders()` matches the app.
const env = { ...TEST_ENV, POSTMARK_WEBHOOK_SECRET: 'hook-secret' } as NodeJS.ProcessEnv;

// Postmark sends Basic Auth; the receiver checks the password against the secret.
const webhookAuth = {
  authorization: `Basic ${Buffer.from('postmark:hook-secret').toString('base64')}`,
  'content-type': 'application/json',
};

function build() {
  const container: Container = buildContainer(env);
  container.rebind(CAMPAIGN_TYPES.CampaignRepository).to(InMemoryCampaignRepository);
  container.rebind(CAMPAIGN_TYPES.SendRepository).to(InMemorySendRepository);
  container
    .rebind(CAMPAIGN_TYPES.RecipientOutcomeRepository)
    .to(InMemoryRecipientOutcomeRepository);
  container
    .rebind(CAMPAIGN_TYPES.UnhandledEventRepository)
    .to(InMemoryUnhandledEventRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
  container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { app: createApp(container), container };
}

function post(app: ReturnType<typeof build>['app'], headers: Record<string, string>, body: unknown) {
  return app.request('/webhooks/postmark', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('postmark webhook receiver', () => {
  let app: ReturnType<typeof build>['app'];
  let container: Container;
  let auth: Record<string, string>;

  beforeEach(async () => {
    ({ app, container } = build());
    auth = await bearerHeaders();
  });

  async function sendOne(): Promise<string> {
    const newsletter = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
      name: 'Dispatch',
      fromName: 'Editors',
      fromEmail: 'editors@dispatch.example',
    });
    const template = await container.get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate).execute({
      name: 'Shell',
      subject: 'Hi',
      bodyHtml: '<p>Hi</p>',
    });
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId: newsletter.id, email: 'reader@dispatch.example', doubleOptIn: false });
    const created = (await (
      await app.request('/v1/campaigns', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ newsletterId: newsletter.id, name: 'Go', templateId: template.id }),
      })
    ).json()) as { id: string };
    await app.request(`/v1/campaigns/${created.id}/send`, { method: 'POST', headers: auth });
    return created.id;
  }

  it('rejects a request with no credential (401)', async () => {
    const res = await post(app, { 'content-type': 'application/json' }, { RecordType: 'Delivery' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong credential (401)', async () => {
    const bad = { authorization: `Basic ${Buffer.from('postmark:nope').toString('base64')}`, 'content-type': 'application/json' };
    const res = await post(app, bad, { RecordType: 'Delivery' });
    expect(res.status).toBe(401);
  });

  it('accepts an authenticated event and applies it to the send record', async () => {
    const campaignId = await sendOne();

    const res = await post(app, webhookAuth, {
      RecordType: 'Delivery',
      Recipient: 'reader@dispatch.example',
      MessageID: 'in-memory-1-0',
      DeliveredAt: '2026-07-20T10:00:00Z',
      Tag: campaignId,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');

    const record = (await (
      await app.request(`/v1/campaigns/${campaignId}/send`, { headers: auth })
    ).json()) as { stats: { delivered: number } };
    expect(record.stats.delivered).toBe(1);
  });

  it('200s (tolerates) an authenticated but unrecognized payload', async () => {
    const res = await post(app, webhookAuth, { RecordType: 'SomethingNew' });
    expect(res.status).toBe(200);
  });
});

/**
 * Issue #29: an unrecognized payload must still 200, but it must no longer
 * vanish. The receiver's tolerance was silent *and* undetectable — if Postmark
 * renamed a record type, those events were lost with nothing to find.
 */
describe('unrecognized events are recorded, not dropped', () => {
  let app: ReturnType<typeof build>['app'];
  let auth: Record<string, string>;

  beforeEach(async () => {
    ({ app } = build());
    auth = await bearerHeaders();
  });

  async function unhandled(): Promise<
    { key: string; count: number; sample: string; firstSeenAt: string; lastSeenAt: string }[]
  > {
    const res = await app.request('/v1/webhooks/unhandled', { headers: auth });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: [] }).data;
  }

  it('counts one row per record type, however many events arrive', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await post(app, webhookAuth, {
        RecordType: 'SubscriptionChange',
        Recipient: `reader${i}@dispatch.example`,
      });
      expect(res.status).toBe(200);
    }

    const rows = await unhandled();
    // The whole point of keying by type: three events, one row. At 50k webhooks
    // per send, one row per *event* would be the growth problem all over again.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'SubscriptionChange', count: 3 });
    // The sample is the FIRST payload seen, so the row stays stable over time.
    expect(rows[0]!.sample).toContain('reader0@dispatch.example');
    expect(rows[0]!.firstSeenAt).toBeDefined();
    expect(rows[0]!.lastSeenAt).toBeDefined();
  });

  it('buckets a malformed body under a sentinel key', async () => {
    // A body with no RecordType at all still parses as JSON, so it reaches the
    // use case — and is exactly the kind of surprise worth seeing.
    const res = await post(app, webhookAuth, { NotARecord: true });
    expect(res.status).toBe(200);

    expect((await unhandled()).map((r) => r.key)).toEqual(['__unparseable']);
  });

  it('records nothing for a deliberately-ignored bounce type', async () => {
    const res = await post(app, webhookAuth, {
      RecordType: 'Bounce',
      Type: 'AutoResponder',
      Email: 'ooo@dispatch.example',
    });
    expect(res.status).toBe(200);

    // An out-of-office reply is not a failure (ADR-020) — a row here would be
    // noise that trains people to stop reading the report.
    expect(await unhandled()).toEqual([]);
  });

  it('records nothing for events it handles', async () => {
    const res = await post(app, webhookAuth, {
      RecordType: 'Delivery',
      Recipient: 'reader@dispatch.example',
      MessageID: 'm-1',
      Tag: 'no-such-campaign',
    });
    expect(res.status).toBe(200);

    // Note the unknown Tag: the event was *handled* and merely uncorrelatable,
    // which is a different thing from unrecognized and must not be reported.
    expect(await unhandled()).toEqual([]);
  });

  it('requires a JWT to read (unlike the receiver, which is Basic-Auth’d)', async () => {
    expect((await app.request('/v1/webhooks/unhandled')).status).toBe(401);
  });
});
