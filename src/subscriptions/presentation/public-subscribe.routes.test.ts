import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV } from '../../shared/testing/index.js';
import { CAPTCHA_TYPES, FakeCaptchaVerifier, type CaptchaVerifier } from '../../shared/captcha/index.js';
import { createApp } from '../../app.js';
import { NEWSLETTER_TYPES, InMemoryNewsletterRepository, CreateNewsletter } from '../../newsletters/index.js';
import { SUBSCRIPTION_TYPES, InMemorySubscriptionRepository, ListSubscriptions } from '../index.js';

const SITE = 'https://www.dispatch.example';

function build(extraEnv: Record<string, string> = {}, captcha = new FakeCaptchaVerifier()) {
  const container: Container = buildContainer({ ...TEST_ENV, ...extraEnv } as NodeJS.ProcessEnv);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  container.rebind<CaptchaVerifier>(CAPTCHA_TYPES.CaptchaVerifier).toConstantValue(captcha);
  return { app: createApp(container), container };
}

async function seed(container: Container, publicSignup = true): Promise<string> {
  const created = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
    name: 'The Weekly Dispatch',
    fromName: 'Dispatch Editors',
    fromEmail: 'editors@dispatch.example',
    campaignChannel: 'weekly-dispatch',
    confirmationChannel: 'weekly-confirmations',
    publicSignup,
  });
  return created.id;
}

function post(app: { request: Hono['request'] }, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request('/v1/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('public signup route (ADR-034)', () => {
  let app: ReturnType<typeof build>['app'];
  let container: Container;
  let newsletterId: string;

  beforeEach(async () => {
    ({ app, container } = build());
    newsletterId = await seed(container);
  });

  const valid = () => ({ newsletterId, email: 'reader@example.com', captchaToken: FakeCaptchaVerifier.PASS });

  it('is open — no JWT — and answers 202 accepted', async () => {
    const res = await post(app, valid(), { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'UA' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });

    const [row] = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, limit: 5 });
    expect(row).toMatchObject({ status: 'subscribed', signupIp: '203.0.113.7', signupUserAgent: 'UA' });
  });

  it('gives the same answer for an address that is already subscribed', async () => {
    await post(app, valid());
    const again = await post(app, valid());
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: 'accepted' });
  });

  it('answers 400 captcha_failed for a rejected token', async () => {
    const res = await post(app, { ...valid(), captchaToken: 'forged' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('captcha_failed');
  });

  it('answers 404 for a newsletter that is closed to public signup', async () => {
    const closed = await seed(container, false);
    expect((await post(app, { ...valid(), newsletterId: closed })).status).toBe(404);
  });

  it('answers 503 when public signup is not configured', async () => {
    ({ app, container } = build({}, new FakeCaptchaVerifier(false)));
    newsletterId = await seed(container);
    expect((await post(app, valid())).status).toBe(503);
  });

  it('refuses reserved names, too many fields, and a missing captcha token', async () => {
    expect((await post(app, { ...valid(), customFields: { source: 'x' } })).status).toBe(400);
    expect((await post(app, { ...valid(), customFields: { SignupIp: '1.2.3.4' } })).status).toBe(400);
    const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, 'v']));
    expect((await post(app, { ...valid(), customFields: tooMany })).status).toBe(400);
    const { captchaToken: _t, ...noToken } = valid();
    void _t;
    expect((await post(app, noToken)).status).toBe(400);
  });

  describe('CORS', () => {
    it('lets an allowed origin call it cross-origin, preflight included', async () => {
      ({ app, container } = build({ CORS_ALLOWED_ORIGINS: SITE }));
      newsletterId = await seed(container);

      const preflight = await app.request('/v1/subscribe', {
        method: 'OPTIONS',
        headers: {
          origin: SITE,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(SITE);

      const res = await post(app, valid(), { origin: SITE });
      expect(res.status).toBe(202);
      expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    });

    it('does not allow any other origin', async () => {
      ({ app, container } = build({ CORS_ALLOWED_ORIGINS: SITE }));
      newsletterId = await seed(container);
      const res = await post(app, valid(), { origin: 'https://evil.example' });
      expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    });

    it('sends no CORS headers when no origins are configured', async () => {
      const res = await post(app, valid(), { origin: SITE });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('stays open under a host mount prefix (ADR-027)', async () => {
    const host = new Hono();
    host.route('/newsletter', app);
    const res = await host.request('/newsletter/v1/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid()),
    });
    expect(res.status).toBe(202);
  });
});
