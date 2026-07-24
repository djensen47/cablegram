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
  const q = new URLSearchParams({ newsletterId, subscriptionId, token });
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

  it('GET is reachable with NO JWT and renders an HTML confirmation by default', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, token));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toMatch(/unsubscribed/i);
    expect(await currentStatus()).toBe('unsubscribed');
  });

  it('GET redirects to the configured landing page (with the address) when enabled', async () => {
    ({ app, container } = build({
      UNSUBSCRIBE_REDIRECT_ENABLED: 'true',
      UNSUBSCRIBE_REDIRECT_URL: 'https://example.com/goodbye',
    }));
    ({ newsletterId, subscriptionId } = await seed(container));
    token = unsubscribeToken(TEST_JWT_SECRET, newsletterId, subscriptionId);

    const res = await app.request(unsubUrl(newsletterId, subscriptionId, token));
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('https://example.com/goodbye');
    expect(location).toContain('email=reader%40dispatch.example');
  });

  it('POST one-click (List-Unsubscribe=One-Click) works with no JWT and returns 200', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, token), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toEqual({ status: 'unsubscribed' });
    expect(await currentStatus()).toBe('unsubscribed');
  });

  it('rejects a forged token (400) and leaves the subscription subscribed', async () => {
    const res = await app.request(unsubUrl(newsletterId, subscriptionId, 'forged'));
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
