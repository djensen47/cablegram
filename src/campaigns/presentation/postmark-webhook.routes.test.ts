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
import { CAMPAIGN_TYPES, InMemoryCampaignRepository, InMemorySendRecordRepository } from '../index.js';
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
  container.rebind(CAMPAIGN_TYPES.SendRecordRepository).to(InMemorySendRecordRepository);
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
    ).json()) as { recipients: { address: string; status: string }[]; stats: { delivered: number } };
    expect(record.recipients[0]?.status).toBe('delivered');
    expect(record.stats.delivered).toBe(1);
  });

  it('200s (tolerates) an authenticated but unrecognized payload', async () => {
    const res = await post(app, webhookAuth, { RecordType: 'SomethingNew' });
    expect(res.status).toBe(200);
  });
});
