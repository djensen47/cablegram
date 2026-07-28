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
import { CAMPAIGN_TYPES, InMemoryCampaignRepository, InMemorySendRepository,
  InMemoryRecipientOutcomeRepository,
  InMemoryUnhandledEventRepository } from '../index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';

function build() {
  const container: Container = buildContainer(TEST_ENV);
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
  let auth: Record<string, string>;

  beforeEach(async () => {
    ({ app, container, gateway } = build());
    auth = await bearerHeaders();
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

  it('requires a JWT', async () => {
    const res = await app.request('/v1/campaigns');
    expect(res.status).toBe(401);
  });

  it('creates a campaign (201, draft) with a template reference', async () => {
    const res = await createCampaign({ newsletterId, name: 'March', templateId });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      status: string;
      templateId: string;
      recipientCount: number;
    };
    expect(json.status).toBe('draft');
    expect(json.templateId).toBe(templateId);
    expect(json.recipientCount).toBe(0);
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
    const json = (await res.json()) as { status: string; recipientCount: number };
    expect(json.status).toBe('sent');
    expect(json.recipientCount).toBe(1);
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
    // The send carries submission facts + live stats. Recipients are NOT
    // inlined (ADR-019) — at scale that is a multi-megabyte response.
    const send = (await after.json()) as {
      recipientCount: number;
      stats: { recipients: number };
      recipients?: unknown;
    };
    expect(send.recipientCount).toBe(1);
    expect(send.stats.recipients).toBe(1);
    expect(send.recipients).toBeUndefined();

    // They are their own cursor-paginated resource.
    const listed = await app.request(
      `/v1/campaigns/${created.id}/send/recipients`,
      { headers: auth },
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      data: { address: string; status: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.address).toBe('reader@dispatch.example');
    expect(page.meta.nextCursor).toBeNull();
  });

  describe('test send (ADR-025)', () => {
    async function draftCampaign(): Promise<string> {
      const created = (await (
        await createCampaign({ newsletterId, name: 'Proof', templateId })
      ).json()) as { id: string };
      return created.id;
    }

    function testSend(id: string, body: Record<string, unknown>) {
      return app.request(`/v1/campaigns/${id}/test`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
      });
    }

    it('sends only to the addresses given and records nothing', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      const id = await draftCampaign();

      const res = await testSend(id, { to: ['me@example.com'] });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { sent: string[]; subject: string; suppressed: string[] };
      expect(json.sent).toEqual(['me@example.com']);
      expect(json.subject).toBe('[TEST] Hello');
      expect(json.suppressed).toEqual([]);
      // The subscriber was NOT mailed — the address list is the recipient set.
      expect(gateway.sent).toHaveLength(1);
      expect(gateway.sent[0]?.recipients.map((r) => r.email)).toEqual(['me@example.com']);

      // Nothing was written: still draft, and no send record to read.
      const after = (await (await app.request(`/v1/campaigns/${id}`, { headers: auth })).json()) as {
        status: string;
        sendId: string | null;
      };
      expect(after.status).toBe('draft');
      expect(after.sendId).toBeNull();
      const send = await app.request(`/v1/campaigns/${id}/send`, { headers: auth });
      expect(send.status).toBe(404);
    });

    it('sends the subject unprefixed when asked', async () => {
      const id = await draftCampaign();
      const res = await testSend(id, { to: ['me@example.com'], prefixSubject: false });
      expect(((await res.json()) as { subject: string }).subject).toBe('Hello');
    });

    it('rejects an empty or over-long target list (400)', async () => {
      const id = await draftCampaign();

      expect((await testSend(id, { to: [] })).status).toBe(400);
      expect(
        (
          await testSend(id, {
            to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'],
          })
        ).status,
      ).toBe(400);
      expect((await testSend(id, { to: ['not-an-email'] })).status).toBe(400);
      expect(gateway.sent).toHaveLength(0);
    });

    it('404s an unknown campaign', async () => {
      const res = await testSend('nope', { to: ['me@example.com'] });
      expect(res.status).toBe(404);
    });

    it('requires a JWT', async () => {
      const id = await draftCampaign();
      const res = await app.request(`/v1/campaigns/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ to: ['me@example.com'] }),
      });
      expect(res.status).toBe(401);
    });
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

  it('honours Idempotency-Key on create: a replayed key does not create a second campaign', async () => {
    const headers = { ...auth, 'idempotency-key': 'create-march-once' };
    const body = JSON.stringify({ newsletterId, name: 'March', templateId });

    const first = await app.request('/v1/campaigns', { method: 'POST', headers, body });
    const second = await app.request('/v1/campaigns', { method: 'POST', headers, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    const list = await app.request(`/v1/campaigns?newsletterId=${newsletterId}`, { headers: auth });
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it('serves the campaigns and webhook paths in the generated OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/campaigns');
    expect(doc.paths).toHaveProperty('/v1/campaigns/{id}/send');
    expect(doc.paths).toHaveProperty('/v1/campaigns/{id}/test');
    expect(doc.paths).toHaveProperty('/webhooks/postmark');
  });
});
