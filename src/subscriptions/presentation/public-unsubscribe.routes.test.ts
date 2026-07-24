import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV, TEST_JWT_SECRET } from '../../shared/testing/index.js';
import { unsubscribeToken } from '../../shared/auth/index.js';
import { createApp } from '../../app.js';
import { NEWSLETTER_TYPES, InMemoryNewsletterRepository, CreateNewsletter } from '../../newsletters/index.js';
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository, Subscribe, ListSubscriptions } from '../index.js';

function build(extraEnv: Record<string, string> = {}) {
  const container: Container = buildContainer({ ...TEST_ENV, ...extraEnv } as NodeJS.ProcessEnv);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  return { app: createApp(container), container };
}

async function seed(container: Container): Promise<{ newsletterId: string; subscriptionId: string }> {
  const newsletter = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
    name: 'The Weekly Dispatch',
    fromName: 'Dispatch Editors',
    fromEmail: 'editors@dispatch.example',
  });
  const subscription = await container
    .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
    .execute({ newsletterId: newsletter.id, email: 'reader@dispatch.example', doubleOptIn: false });
  return { newsletterId: newsletter.id, subscriptionId: subscription.id };
}

function unsubUrl(newsletterId: string, subscriptionId: string, token: string): string {
  const q = new URLSearchParams({ newsletterId, subscriptionId, token, email: 'reader@dispatch.example' });
  return `/v1/unsubscribe?${q.toString()}`;
}

describe('public unsubscribe routes (ADR-015)', () => {
  let app: ReturnType<typeof build>['app'];
  let container: Container;
  let newsletterId: string;
  let subscriptionId: string;
  let token: string;

  beforeEach(async () => {
    ({ app, container } = build());
    ({ newsletterId, subscriptionId } = await seed(container));
    token = unsubscribeToken(TEST_JWT_SECRET, newsletterId, subscriptionId);
  });

  async function currentStatus(): Promise<string | undefined> {
    const rows = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, limit: 10 });
    return rows[0]?.status;
  }

  it('GET is reachable with NO JWT, renders an HTML page, and does NOT unsubscribe (scanner-safe)', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toMatch(/unsubscribe/i);
    // The GET must not mutate — a pre-fetching link scanner cannot opt anyone out.
    expect(await currentStatus()).toBe('subscribed');
  });

  it('POST one-click (List-Unsubscribe=One-Click) unsubscribes with no JWT and returns JSON', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, token), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string; email: string }).toEqual({
      status: 'unsubscribed',
      email: 'reader@dispatch.example',
    });
    expect(await currentStatus()).toBe('unsubscribed');
  });

  it('POST rejects a forged token (400) and leaves the subscription subscribed', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, 'forged'), { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await currentStatus()).toBe('subscribed');
  });

  it('the operator JWT unsubscribe endpoint still requires a token (401)', async () => {
    const res = await app.request(
      `/v1/newsletters/${newsletterId}/subscriptions/${subscriptionId}/unsubscribe`,
      { method: 'POST' },
    );
    expect(res.status).toBe(401);
  });

  it('advertises the public /v1/unsubscribe path in the OpenAPI document', async () => {
    const res = await app.request('/openapi.json');
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths).toHaveProperty('/v1/unsubscribe');
  });
});
