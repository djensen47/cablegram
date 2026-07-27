import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';
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
import {
  DELIVERABILITY_TYPES,
  InMemorySuppressionRepository,
} from '../../deliverability/index.js';
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository } from '../index.js';

function build() {
  const container: Container = buildContainer(TEST_ENV);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  // The import route writes imported hard bounces to the global list (ADR-022).
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
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
  let auth: Record<string, string>;

  beforeEach(async () => {
    ({ app, container, gateway } = build());
    auth = await bearerHeaders();
    newsletterId = await seedNewsletter(container);
  });

  function subscribe(body: Record<string, unknown>) {
    return app.request(`/v1/newsletters/${newsletterId}/subscriptions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });
  }

  it('requires a JWT', async () => {
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
    expect(doc.paths).toHaveProperty('/v1/newsletters/{newsletterId}/subscriptions/import');
  });

  describe('import (ADR-022)', () => {
    function importBatch(body: Record<string, unknown>, headers: Record<string, string> = {}) {
      return app.request(`/v1/newsletters/${newsletterId}/subscriptions/import`, {
        method: 'POST',
        headers: { ...auth, ...headers },
        body: JSON.stringify(body),
      });
    }

    it('requires a JWT', async () => {
      const res = await app.request(`/v1/newsletters/${newsletterId}/subscriptions/import`, {
        method: 'POST',
        body: JSON.stringify({ rows: [{ email: 'a@dispatch.example' }] }),
      });
      expect(res.status).toBe(401);
    });

    it('imports a batch of statuses and sends no email', async () => {
      const res = await importBatch({
        rows: [
          { email: 'a@dispatch.example', status: 'subscribed' },
          { email: 'b@dispatch.example', status: 'unsubscribed' },
          { email: 'c@dispatch.example', status: 'bounced' },
        ],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ received: 3, created: 3, skipped: 0 });
      expect(gateway.sent).toHaveLength(0);
    });

    it('parses subscribedAt off the wire into the stored consent date', async () => {
      await importBatch({
        rows: [{ email: 'a@dispatch.example', subscribedAt: '2019-04-02T09:15:00.000Z' }],
      });

      const list = await app.request(`/v1/newsletters/${newsletterId}/subscriptions`, {
        headers: auth,
      });
      const page = (await list.json()) as { data: { createdAt: string }[] };
      expect(page.data[0]?.createdAt).toBe('2019-04-02T09:15:00.000Z');
    });

    it('rejects an unknown status at the edge (400) rather than defaulting it', async () => {
      const res = await importBatch({
        rows: [{ email: 'a@dispatch.example', status: 'cleaned' }],
      });

      expect(res.status).toBe(400);
    });

    it('rejects a batch over the row cap', async () => {
      const res = await importBatch({
        rows: Array.from({ length: 1001 }, (_, i) => ({ email: `r${i}@dispatch.example` })),
      });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown onConflict mode — there is no merge', async () => {
      const res = await importBatch({
        rows: [{ email: 'a@dispatch.example' }],
        onConflict: 'merge',
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown newsletter', async () => {
      const res = await app.request('/v1/newsletters/missing/subscriptions/import', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ rows: [{ email: 'a@dispatch.example' }] }),
      });

      expect(res.status).toBe(404);
    });

    it('replays a retried batch under the same Idempotency-Key instead of re-running it', async () => {
      const body = {
        rows: [{ email: 'a@dispatch.example', status: 'subscribed' }],
        onConflict: 'overwrite',
      };
      const headers = { 'Idempotency-Key': 'batch-0' };

      const first = await importBatch(body, headers);
      const replay = await importBatch(body, headers);

      // Without the replay the second call would report `updated: 1`; the
      // cached response proves the handler did not run again.
      expect(await first.json()).toMatchObject({ created: 1, updated: 0 });
      expect(await replay.json()).toMatchObject({ created: 1, updated: 0 });
    });
  });
});
