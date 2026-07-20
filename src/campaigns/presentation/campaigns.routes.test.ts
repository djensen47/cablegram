import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { createApp } from '../../app.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from '../../shared/email/index.js';
import {
  NEWSLETTER_TYPES,
  InMemoryNewsletterRepository,
  CreateNewsletter,
} from '../../newsletters/index.js';
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository, Subscribe } from '../../subscriptions/index.js';
import { DELIVERABILITY_TYPES, InMemorySuppressionRepository } from '../../deliverability/index.js';
import { TEMPLATE_TYPES, InMemoryTemplateRepository, CreateTemplate } from '../../templates/index.js';
import { CAMPAIGN_TYPES, InMemoryCampaignRepository, InMemorySendRecordRepository } from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

const auth = { 'x-api-key': 'k1', 'content-type': 'application/json' };

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
  return { app: createApp(container), container, gateway };
}

async function seedNewsletter(container: Container): Promise<string> {
  const newsletter = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
    name: 'The Weekly Dispatch',
    fromName: 'Dispatch Editors',
    fromEmail: 'editors@dispatch.example',
  });
  return newsletter.id;
}

async function seedTemplate(container: Container): Promise<string> {
  const template = await container.get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate).execute({
    name: 'Shell',
    subject: 'Hello',
    bodyHtml: '<p>Hi</p>',
  });
  return template.id;
}

describe('campaigns routes', () => {
  let app: ReturnType<typeof build>['app'];
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let newsletterId: string;
  let templateId: string;

  beforeEach(async () => {
    ({ app, container, gateway } = build());
    newsletterId = await seedNewsletter(container);
    templateId = await seedTemplate(container);
  });

  function createCampaign(body: Record<string, unknown>) {
    return app.request('/v1/campaigns', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
  }

  it('requires an API key', async () => {
    const res = await app.request('/v1/campaigns');
    expect(res.status).toBe(401);
  });

  it('creates a campaign (201, draft) with a template reference', async () => {
    const res = await createCampaign({ newsletterId, name: 'March', templateId });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { status: string; templateId: string; stats: { recipients: number } };
    expect(json.status).toBe('draft');
    expect(json.templateId).toBe(templateId);
    expect(json.stats.recipients).toBe(0);
  });

  it('rejects a campaign with neither template nor inline content (400)', async () => {
    const res = await createCampaign({ newsletterId, name: 'Bad' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('returns 404 creating a campaign for a missing newsletter', async () => {
    const res = await createCampaign({ newsletterId: 'missing', name: 'X', templateId });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('gets a campaign and 404s an unknown id', async () => {
    const created = (await (await createCampaign({ newsletterId, name: 'M', templateId })).json()) as {
      id: string;
    };
    const ok = await app.request(`/v1/campaigns/${created.id}`, { headers: auth });
    expect(ok.status).toBe(200);
    const missing = await app.request('/v1/campaigns/nope', { headers: auth });
    expect(missing.status).toBe(404);
  });

  it('updates a draft campaign (200)', async () => {
    const created = (await (await createCampaign({ newsletterId, name: 'M', templateId })).json()) as {
      id: string;
    };
    const res = await app.request(`/v1/campaigns/${created.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: 'March Renamed', segmentTags: ['vip'] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { name: string; segmentTags: string[] };
    expect(json.name).toBe('March Renamed');
    expect(json.segmentTags).toEqual(['vip']);
  });

  it('lists campaigns in the { data, meta } envelope with a newsletterId filter', async () => {
    const other = await seedNewsletter(container);
    await createCampaign({ newsletterId, name: 'A', templateId });
    await createCampaign({ newsletterId, name: 'B', templateId });
    await createCampaign({ newsletterId: other, name: 'C', templateId });

    const res = await app.request(`/v1/campaigns?limit=1&newsletterId=${newsletterId}`, { headers: auth });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      data: { newsletterId: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.newsletterId).toBe(newsletterId);
    expect(page.meta.nextCursor).toBeTruthy();
  });

  it('sends a campaign (200 sent) to its subscribed recipients', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    const created = (await (await createCampaign({ newsletterId, name: 'Go', templateId })).json()) as {
      id: string;
    };

    const res = await app.request(`/v1/campaigns/${created.id}/send`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; stats: { recipients: number; accepted: number } };
    expect(json.status).toBe('sent');
    expect(json.stats).toMatchObject({ recipients: 1, accepted: 1 });
    expect(gateway.sent).toHaveLength(1);
  });

  it('exposes the send record after a send and 404s before one', async () => {
    await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
    const created = (await (await createCampaign({ newsletterId, name: 'Go', templateId })).json()) as {
      id: string;
    };

    const before = await app.request(`/v1/campaigns/${created.id}/send`, { headers: auth });
    expect(before.status).toBe(404);

    await app.request(`/v1/campaigns/${created.id}/send`, { method: 'POST', headers: auth });

    const after = await app.request(`/v1/campaigns/${created.id}/send`, { headers: auth });
    expect(after.status).toBe(200);
    const record = (await after.json()) as { recipients: { address: string; status: string }[] };
    expect(record.recipients).toHaveLength(1);
    expect(record.recipients[0]?.address).toBe('reader@dispatch.example');
  });

  it('deletes a campaign (204) then 404s a get', async () => {
    const created = (await (await createCampaign({ newsletterId, name: 'M', templateId })).json()) as {
      id: string;
    };
    const del = await app.request(`/v1/campaigns/${created.id}`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(204);
    const get = await app.request(`/v1/campaigns/${created.id}`, { headers: auth });
    expect(get.status).toBe(404);
  });

  it('serves the campaigns and webhook paths in the generated OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/campaigns');
    expect(doc.paths).toHaveProperty('/v1/campaigns/{id}/send');
    expect(doc.paths).toHaveProperty('/webhooks/postmark');
  });
});
