import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
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
  SUBSCRIPTION_TYPES,
  InMemorySubscriptionRepository,
  Subscribe,
  ConfirmSubscription,
  Unsubscribe,
  ListSubscriptions,
  ResolveRecipients,
  SubscriptionNewsletterNotFoundError,
  SubscriptionNotFoundError,
  SubscriptionStateError,
  InvalidSubscriptionEmailError,
} from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  API_KEYS: 'k1',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// Rebind the subscription repository and the email gateway to their in-memory
// doubles (ADR-003); the newsletters repo is rebound too so the DAG dependency
// (subscribe validates the target newsletter) runs on real wiring, no DB.
function testContainer(): { container: Container; gateway: InMemoryDeliveryGateway } {
  const container = buildContainer(env);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  const gateway = new InMemoryDeliveryGateway();
  container.rebind<DeliveryGateway>(EMAIL_TYPES.DeliveryGateway).toConstantValue(gateway);
  return { container, gateway };
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

describe('subscriptions use cases', () => {
  let container: Container;
  let gateway: InMemoryDeliveryGateway;
  let newsletterId: string;

  beforeEach(async () => {
    ({ container, gateway } = testContainer());
    newsletterId = await seedNewsletter(container);
  });

  it('double opt-in creates a pending subscription and sends exactly one confirmation email', async () => {
    const subscription = await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'Reader@Dispatch.Example', doubleOptIn: true });

    expect(subscription.status).toBe('pending');
    expect(subscription.email).toBe('reader@dispatch.example');
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]?.recipients).toEqual([{ email: 'reader@dispatch.example' }]);
    expect(gateway.sent[0]?.from.fromEmail).toBe('editors@dispatch.example');
  });

  it('single opt-in creates a subscribed subscription and sends no email', async () => {
    const subscription = await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });

    expect(subscription.status).toBe('subscribed');
    expect(gateway.sent).toHaveLength(0);
  });

  it('rejects subscribing to a newsletter that does not exist', async () => {
    await expect(
      container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId: 'missing', email: 'reader@dispatch.example' }),
    ).rejects.toBeInstanceOf(SubscriptionNewsletterNotFoundError);
  });

  it('rejects an invalid address', async () => {
    await expect(
      container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(InvalidSubscriptionEmailError);
  });

  it('confirm moves pending → subscribed', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    const pending = await subscribe.execute({ newsletterId, email: 'reader@dispatch.example' });

    const confirmed = await container
      .get<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription)
      .execute(newsletterId, pending.id);

    expect(confirmed.status).toBe('subscribed');
  });

  it('confirm scopes by newsletter: a valid id under the wrong newsletter is not found', async () => {
    const pending = await container
      .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
      .execute({ newsletterId, email: 'reader@dispatch.example' });

    await expect(
      container
        .get<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription)
        .execute('another-newsletter', pending.id),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });

  it('is idempotent: re-subscribing an active membership returns the same row, no extra email', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    const first = await subscribe.execute({ newsletterId, email: 'reader@dispatch.example' });
    const second = await subscribe.execute({ newsletterId, email: 'READER@dispatch.example' });

    expect(second.id).toBe(first.id);
    expect(gateway.sent).toHaveLength(1); // no second confirmation
  });

  it('re-subscribe after unsubscribe revives the same row (no duplicate)', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    const created = await subscribe.execute({
      newsletterId,
      email: 'reader@dispatch.example',
      doubleOptIn: false,
    });

    await container
      .get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe)
      .execute(newsletterId, created.id);

    const revived = await subscribe.execute({
      newsletterId,
      email: 'reader@dispatch.example',
      doubleOptIn: false,
    });

    expect(revived.id).toBe(created.id);
    expect(revived.status).toBe('subscribed');

    const rows = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, limit: 50 });
    expect(rows).toHaveLength(1);
  });

  it('cannot confirm an unsubscribed subscription', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    const created = await subscribe.execute({
      newsletterId,
      email: 'reader@dispatch.example',
      doubleOptIn: false,
    });
    await container
      .get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe)
      .execute(newsletterId, created.id);

    await expect(
      container
        .get<ConfirmSubscription>(SUBSCRIPTION_TYPES.ConfirmSubscription)
        .execute(newsletterId, created.id),
    ).rejects.toBeInstanceOf(SubscriptionStateError);
  });

  it('resolveRecipients returns only subscribed rows, projecting the merge model', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    // subscribed (single opt-in), with a merge model
    await subscribe.execute({
      newsletterId,
      email: 'active@dispatch.example',
      doubleOptIn: false,
      mergeFields: { firstName: 'Ada' },
    });
    // pending (double opt-in) — must be excluded
    await subscribe.execute({ newsletterId, email: 'pending@dispatch.example', doubleOptIn: true });
    // unsubscribed — must be excluded
    const gone = await subscribe.execute({
      newsletterId,
      email: 'gone@dispatch.example',
      doubleOptIn: false,
    });
    await container.get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe).execute(newsletterId, gone.id);

    const recipients = await container
      .get<ResolveRecipients>(SUBSCRIPTION_TYPES.ResolveRecipients)
      .execute(newsletterId);

    expect(recipients).toEqual([
      { address: 'active@dispatch.example', mergeModel: { firstName: 'Ada' } },
    ]);
  });

  it('resolveRecipients honours a query-time tag segment (AND over tags)', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    await subscribe.execute({
      newsletterId,
      email: 'vip@dispatch.example',
      doubleOptIn: false,
      tags: ['vip', 'beta'],
    });
    await subscribe.execute({
      newsletterId,
      email: 'plain@dispatch.example',
      doubleOptIn: false,
      tags: ['beta'],
    });

    const vips = await container
      .get<ResolveRecipients>(SUBSCRIPTION_TYPES.ResolveRecipients)
      .execute(newsletterId, { tags: ['vip'] });

    expect(vips.map((r) => r.address)).toEqual(['vip@dispatch.example']);
  });

  it('lists with a limit+1 sentinel and a status filter', async () => {
    const subscribe = container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe);
    for (let i = 0; i < 3; i++) {
      await subscribe.execute({
        newsletterId,
        email: `reader${i}@dispatch.example`,
        doubleOptIn: false,
      });
    }
    await subscribe.execute({
      newsletterId,
      email: 'pending@dispatch.example',
      doubleOptIn: true,
    });

    const subscribed = await container
      .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
      .execute({ newsletterId, status: 'subscribed', limit: 2 });

    // limit + 1 fetched so the caller can detect a next page; pending excluded.
    expect(subscribed).toHaveLength(3);
    expect(subscribed.every((s) => s.status === 'subscribed')).toBe(true);
    const ids = subscribed.map((s) => s.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
