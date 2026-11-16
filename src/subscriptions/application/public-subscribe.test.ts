import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV } from '../../shared/testing/index.js';
import { CAPTCHA_TYPES, FakeCaptchaVerifier, type CaptchaVerifier } from '../../shared/captcha/index.js';
import {
  EMAIL_TYPES,
  InMemoryDeliveryGateway,
  type DeliveryGateway,
} from '../../shared/email/index.js';
import { NEWSLETTER_TYPES, InMemoryNewsletterRepository, CreateNewsletter } from '../../newsletters/index.js';
import {
  SUBSCRIPTION_TYPES,
  InMemorySubscriptionRepository,
  ListSubscriptions,
  PublicSubscribe,
  Subscribe,
  Unsubscribe,
  InvalidCaptchaError,
  PublicSignupUnavailableError,
  SubscriptionNewsletterNotFoundError,
} from '../index.js';

const PASS = FakeCaptchaVerifier.PASS;
const EVIDENCE = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test' };

function testContainer(captcha: FakeCaptchaVerifier) {
  const container: Container = buildContainer(TEST_ENV);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  container.rebind<CaptchaVerifier>(CAPTCHA_TYPES.CaptchaVerifier).toConstantValue(captcha);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { container, gateway };
}

async function newsletter(
  container: Container,
  opts: { publicSignup?: boolean; doubleOptIn?: boolean } = {},
): Promise<string> {
  const created = await container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter).execute({
    name: 'The Weekly Dispatch',
    fromName: 'Dispatch Editors',
    fromEmail: 'editors@dispatch.example',
    campaignChannel: 'weekly-dispatch',
    confirmationChannel: 'weekly-confirmations',
    publicSignup: opts.publicSignup ?? true,
    doubleOptIn: opts.doubleOptIn,
  });
  return created.id;
}

describe('PublicSubscribe (ADR-034)', () => {
  let captcha: FakeCaptchaVerifier;
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  const signup = (input: Partial<Parameters<PublicSubscribe['execute']>[0]> & { newsletterId: string }) =>
    container.get<PublicSubscribe>(SUBSCRIPTION_TYPES.PublicSubscribe).execute({
      email: 'reader@example.com',
      captchaToken: PASS,
      evidence: EVIDENCE,
      ...input,
    });
  const rows = (newsletterId: string) =>
    container.get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions).execute({ newsletterId, limit: 50 });

  beforeEach(() => {
    captcha = new FakeCaptchaVerifier();
    ({ container, gateway } = testContainer(captcha));
  });

  it('subscribes, recording the visitor IP and user agent as consent evidence', async () => {
    const id = await newsletter(container);

    await signup({ newsletterId: id, customFields: { city: 'Seattle', state: 'WA' } });

    const [row] = await rows(id);
    expect(row).toMatchObject({ email: 'reader@example.com', status: 'subscribed' });
    expect(row!.signupIp).toBe('203.0.113.7');
    expect(row!.signupUserAgent).toBe('Mozilla/5.0 test');
    expect(row!.customFields).toEqual({ city: 'Seattle', state: 'WA' });
    // The visitor's IP is forwarded to Turnstile too.
    expect(captcha.calls[0]).toEqual({ token: PASS, remoteIp: '203.0.113.7' });
  });

  it('is unavailable — not unprotected — when no captcha secret is configured', async () => {
    ({ container } = testContainer(new FakeCaptchaVerifier(false)));
    const id = await newsletter(container);
    await expect(signup({ newsletterId: id })).rejects.toBeInstanceOf(PublicSignupUnavailableError);
    expect(await rows(id)).toHaveLength(0);
  });

  it('refuses a rejected captcha before looking at the newsletter', async () => {
    const closed = await newsletter(container, { publicSignup: false });
    // A closed newsletter still answers "captcha failed", so a bot cannot
    // probe which newsletter ids exist.
    await expect(signup({ newsletterId: closed, captchaToken: 'forged' })).rejects.toBeInstanceOf(
      InvalidCaptchaError,
    );
  });

  it('treats a closed newsletter and an unknown one the same', async () => {
    const closed = await newsletter(container, { publicSignup: false });
    await expect(signup({ newsletterId: closed })).rejects.toBeInstanceOf(SubscriptionNewsletterNotFoundError);
    await expect(signup({ newsletterId: 'no-such-id' })).rejects.toBeInstanceOf(
      SubscriptionNewsletterNotFoundError,
    );
    expect(await rows(closed)).toHaveLength(0);
  });

  it('leaves an already-subscribed address untouched, quietly', async () => {
    const id = await newsletter(container);
    await signup({ newsletterId: id });
    await signup({ newsletterId: id, customFields: { city: 'Elsewhere' } });
    const all = await rows(id);
    expect(all).toHaveLength(1);
    expect(all[0]!.customFields).toEqual({});
  });

  it('never re-subscribes someone who left, under single opt-in', async () => {
    const id = await newsletter(container);
    const first = await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId: id, email: 'reader@example.com', doubleOptIn: false });
    await container.get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe).execute(id, first.id);

    // Anyone can type an address into a public form; with no confirmation
    // email nothing proves it was the owner, so the opt-out must stand.
    await expect(signup({ newsletterId: id })).resolves.toBeUndefined();
    expect((await rows(id))[0]!.status).toBe('unsubscribed');
  });

  it('revives someone who left under double opt-in, pending their confirmation', async () => {
    const id = await newsletter(container, { doubleOptIn: true });
    const first = await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId: id, email: 'reader@example.com', doubleOptIn: false });
    await container.get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe).execute(id, first.id);
    gateway.sent.length = 0;

    await signup({ newsletterId: id });

    expect((await rows(id))[0]!.status).toBe('pending');
    expect(gateway.sent).toHaveLength(1);
  });

  it("follows the newsletter's opt-in mode; a public caller cannot choose", async () => {
    const id = await newsletter(container, { doubleOptIn: true });
    await signup({ newsletterId: id });
    expect((await rows(id))[0]!.status).toBe('pending');
  });
});
