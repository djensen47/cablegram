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
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository } from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

const auth = { 'x-api-key': 'k1', 'content-type': 'application/json' };

function build() {
  const container: Container = buildContainer(env);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { app: createApp(container), container, gateway };
}

async function seedNewsletter(container: Container): Promise<string> {
  const newsletter = await container
    .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
    .execute({
      name: 'The Weekly Dispatch',
      fromName: 'Dispatch Editors',
      fromEmail: 'editors@dispatch.example',
    });
  return newsletter.id;
}

describe('subscriptions routes', () => {
  let app: ReturnType<typeof build>['app'];
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let newsletterId: string;

  beforeEach(async () => {
    ({ app, container, gateway } = build());
    newsletterId = await seedNewsletter(container);
  });

  function subscribe(body: Record<string, unknown>) {
    return app.request(`/v1/newsletters/${newsletterId}/subscriptions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
  }

  it('requires an API key', async () => {
    const res = await app.request(`/v1/newsletters/${newsletterId}/subscriptions`);
    expect(res.status).toBe(401);
  });

  it('subscribes with double opt-in (201, pending) and sends one email', async () => {
    const res = await subscribe({ email: 'reader@dispatch.example', doubleOptIn: true });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { status: string; email: string };
    expect(json.status).toBe('pending');
    expect(json.email).toBe('reader@dispatch.example');
    expect(gateway.sent).toHaveLength(1);
  });

  it('rejects an invalid address (400 validation_error)', async () => {
    const res = await subscribe({ email: 'nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('returns 404 subscribing to a missing newsletter', async () => {
    const res = await app.request('/v1/newsletters/missing/subscriptions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'reader@dispatch.example' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('confirms a pending subscription (200 subscribed)', async () => {
    const created = (await (await subscribe({ email: 'reader@dispatch.example' })).json()) as {
      id: string;
    };
    const res = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions/${created.id}/confirm`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('subscribed');
  });

  it('unsubscribes a subscription (200 unsubscribed)', async () => {
    const created = (await (
      await subscribe({ email: 'reader@dispatch.example', doubleOptIn: false })
    ).json()) as { id: string };
    const res = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions/${created.id}/unsubscribe`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('unsubscribed');
  });

  it('returns 404 confirming an unknown subscription id', async () => {
    const res = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions/does-not-exist/confirm`,
      { method: 'POST', headers: auth },
    );
    expect(res.status).toBe(404);
  });

  it('lists subscriptions in the { data, meta: { nextCursor } } envelope with a status filter', async () => {
    await subscribe({ email: 'a@dispatch.example', doubleOptIn: false });
    await subscribe({ email: 'b@dispatch.example', doubleOptIn: false });
    await subscribe({ email: 'c@dispatch.example', doubleOptIn: false });
    await subscribe({ email: 'p@dispatch.example', doubleOptIn: true }); // pending

    const firstPage = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions?limit=2&status=subscribed`,
      { headers: auth },
    );
    expect(firstPage.status).toBe(200);
    const page1 = (await firstPage.json()) as {
      data: { email: string; status: string }[];
      meta: { nextCursor: string | null };
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.data.every((s) => s.status === 'subscribed')).toBe(true);
    expect(page1.meta.nextCursor).toBeTruthy();

    const secondPage = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions?limit=2&status=subscribed&cursor=${page1.meta.nextCursor}`,
      { headers: auth },
    );
    const page2 = (await secondPage.json()) as {
      data: unknown[];
      meta: { nextCursor: string | null };
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();
  });

  it('serves the subscriptions paths in the generated OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/newsletters/{newsletterId}/subscriptions');
    expect(doc.paths).toHaveProperty(
      '/v1/newsletters/{newsletterId}/subscriptions/{id}/confirm',
    );
  });
});
