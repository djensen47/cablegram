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
  PublicUnsubscribe,
  ListSubscriptions,
  MarkSubscriptionOutcome,
  ResolveRecipients,
  SubscriptionNewsletterNotFoundError,
  SubscriptionNotFoundError,
  SubscriptionStateError,
  InvalidSubscriptionEmailError,
  InvalidUnsubscribeTokenError,
} from '../index.js';
import {
  DELIVERABILITY_TYPES,
  InMemorySuppressionRepository,
  CheckSuppression,
} from '../../deliverability/index.js';
import { ImportSubscriptions } from '../index.js';
import { unsubscribeToken } from '../../shared/auth/index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// The unsubscribe secret falls back to JWT_SECRET when unset (ADR-015), so
// tokens minted with this value verify inside the container under test.
const UNSUB_SECRET = env.JWT_SECRET as string;

// Rebind the subscription repository and the email gateway to their in-memory
// doubles (ADR-003); the newsletters repo is rebound too so the DAG dependency
// (subscribe validates the target newsletter) runs on real wiring, no DB.
function testContainer(): { container: Container; gateway: InMemoryDeliveryGateway } {
  const container = buildContainer(env);
  container.rebind(SUBSCRIPTION_TYPES.SubscriptionRepository).to(InMemorySubscriptionRepository);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  // The import path writes imported hard bounces to the global list along the
  // `subscriptions → deliverability` edge (ADR-022), so that repository needs
  // its in-memory double too.
  container
    .rebind(DELIVERABILITY_TYPES.SuppressionRepository)
    .to(InMemorySuppressionRepository);
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
    const active = await subscribe.execute({
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
      { subscriptionId: active.id, address: 'active@dispatch.example', mergeModel: { firstName: 'Ada' } },
    ]);
  });

  describe('public token unsubscribe (ADR-015)', () => {
    async function seedSubscribed(email = 'reader@dispatch.example'): Promise<string> {
      const s = await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email, doubleOptIn: false });
      return s.id;
    }

    it('unsubscribes with a valid token and is idempotent', async () => {
      const id = await seedSubscribed();
      const token = unsubscribeToken(UNSUB_SECRET, newsletterId, id);
      const publicUnsub = container.get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe);

      const first = await publicUnsub.execute(newsletterId, id, token);
      expect(first?.status).toBe('unsubscribed');

      // Idempotent: a second call with the same (still valid) token is a no-op.
      const second = await publicUnsub.execute(newsletterId, id, token);
      expect(second?.status).toBe('unsubscribed');
    });

    it('rejects a forged / mismatched token', async () => {
      const id = await seedSubscribed();
      await expect(
        container
          .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
          .execute(newsletterId, id, 'forged-token'),
      ).rejects.toBeInstanceOf(InvalidUnsubscribeTokenError);
    });

    it('does not unsubscribe when the token is presented under the wrong newsletter (ADR-011)', async () => {
      const id = await seedSubscribed();
      // A token minted for this newsletter, replayed against another id, fails
      // verification (the newsletter is bound into the signature).
      const token = unsubscribeToken(UNSUB_SECRET, newsletterId, id);
      await expect(
        container
          .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
          .execute('another-newsletter', id, token),
      ).rejects.toBeInstanceOf(InvalidUnsubscribeTokenError);

      // The row is untouched.
      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.status).toBe('subscribed');
    });

    it('succeeds quietly for a valid token whose subscription no longer exists', async () => {
      // Never seeded: a legitimately-signed token for a since-deleted row.
      const missingId = 'gone-subscription';
      const token = unsubscribeToken(UNSUB_SECRET, newsletterId, missingId);
      const result = await container
        .get<PublicUnsubscribe>(SUBSCRIPTION_TYPES.PublicUnsubscribe)
        .execute(newsletterId, missingId, token);
      expect(result).toBeNull();
    });
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

  // ADR-018: bounces and complaints are per-newsletter statuses in their own
  // right, not just a side effect of the global suppression list.
  describe('import (ADR-022)', () => {
    function importer(): ImportSubscriptions {
      return container.get<ImportSubscriptions>(SUBSCRIPTION_TYPES.ImportSubscriptions);
    }

    async function statusOf(email: string): Promise<string | undefined> {
      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 100 });
      return rows.find((s) => s.email === email)?.status;
    }

    async function suppressed(address: string): Promise<boolean> {
      const entry = await container
        .get<CheckSuppression>(DELIVERABILITY_TYPES.CheckSuppression)
        .execute(address);
      return entry !== null;
    }

    it('restores every status in the vocabulary verbatim', async () => {
      // The reason this use case exists: `Subscribe` derives a status from an
      // opt-in toggle and so can only ever produce pending/subscribed, which
      // makes it incapable of carrying a migration.
      await importer().execute({
        newsletterId,
        rows: [
          { email: 'a@dispatch.example', status: 'subscribed' },
          { email: 'b@dispatch.example', status: 'pending' },
          { email: 'c@dispatch.example', status: 'unsubscribed' },
          { email: 'd@dispatch.example', status: 'bounced' },
          { email: 'e@dispatch.example', status: 'complained' },
        ],
      });

      expect(await statusOf('a@dispatch.example')).toBe('subscribed');
      expect(await statusOf('b@dispatch.example')).toBe('pending');
      expect(await statusOf('c@dispatch.example')).toBe('unsubscribed');
      expect(await statusOf('d@dispatch.example')).toBe('bounced');
      expect(await statusOf('e@dispatch.example')).toBe('complained');
    });

    it('sends no email at all — not even for pending rows', async () => {
      // Importing must never mail the list. A `pending` row here is restored
      // consent, not a new opt-in awaiting confirmation.
      await importer().execute({
        newsletterId,
        rows: [
          { email: 'a@dispatch.example', status: 'pending' },
          { email: 'b@dispatch.example', status: 'subscribed' },
        ],
      });

      expect(gateway.sent).toHaveLength(0);
    });

    it('defaults a row with no status to subscribed, or to defaultStatus', async () => {
      await importer().execute({ newsletterId, rows: [{ email: 'a@dispatch.example' }] });
      await importer().execute({
        newsletterId,
        rows: [{ email: 'b@dispatch.example' }],
        defaultStatus: 'unsubscribed',
      });

      expect(await statusOf('a@dispatch.example')).toBe('subscribed');
      expect(await statusOf('b@dispatch.example')).toBe('unsubscribed');
    });

    it('preserves the original opt-in date as the consent record', async () => {
      const subscribedAt = new Date('2019-04-02T09:15:00.000Z');

      await importer().execute({
        newsletterId,
        rows: [{ email: 'a@dispatch.example', subscribedAt }],
      });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.createdAt).toEqual(subscribedAt);
    });

    it('normalizes addresses and keeps merge fields and tags', async () => {
      await importer().execute({
        newsletterId,
        rows: [
          {
            email: 'Reader@Dispatch.Example',
            mergeFields: { firstName: 'Ada' },
            tags: ['vip', 'vip', ' beta '],
          },
        ],
      });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.email).toBe('reader@dispatch.example');
      expect(rows[0]?.mergeFields).toEqual({ firstName: 'Ada' });
      expect(rows[0]?.tags).toEqual(['vip', 'beta']);
    });

    it('skips an existing membership by default, leaving it untouched', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      await container
        .get<Unsubscribe>(SUBSCRIPTION_TYPES.Unsubscribe)
        .execute(
          newsletterId,
          (
            await container
              .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
              .execute({ newsletterId, limit: 10 })
          )[0]!.id,
        );

      const result = await importer().execute({
        newsletterId,
        rows: [{ email: 'reader@dispatch.example', status: 'subscribed' }],
      });

      // Someone who opted out in cablegram after the export was taken stays out.
      expect(result.skipped).toBe(1);
      expect(result.updated).toBe(0);
      expect(await statusOf('reader@dispatch.example')).toBe('unsubscribed');
    });

    it('replaces an existing membership under overwrite — the file is the truth', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });

      const result = await importer().execute({
        newsletterId,
        onConflict: 'overwrite',
        rows: [
          {
            email: 'reader@dispatch.example',
            status: 'unsubscribed',
            mergeFields: { firstName: 'Ada' },
          },
        ],
      });

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(await statusOf('reader@dispatch.example')).toBe('unsubscribed');
    });

    it('is re-runnable: importing the same file twice creates no duplicates', async () => {
      const rows = [
        { email: 'a@dispatch.example', status: 'subscribed' as const },
        { email: 'b@dispatch.example', status: 'unsubscribed' as const },
      ];

      const first = await importer().execute({ newsletterId, rows });
      const second = await importer().execute({ newsletterId, rows });

      expect(first.created).toBe(2);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(2);
      const all = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 100 });
      expect(all).toHaveLength(2);
    });

    it('keeps the first occurrence when one address repeats inside a batch', async () => {
      const result = await importer().execute({
        newsletterId,
        rows: [
          { email: 'a@dispatch.example', status: 'subscribed' },
          { email: 'A@Dispatch.Example', status: 'unsubscribed' },
        ],
      });

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
      expect(await statusOf('a@dispatch.example')).toBe('subscribed');
    });

    it('puts an imported hard bounce on the GLOBAL suppression list', async () => {
      // Second-hand but still a mailbox fact: the address is dead for every
      // newsletter, and all of them share one sending domain (ADR-018).
      const result = await importer().execute({
        newsletterId,
        rows: [{ email: 'dead@dispatch.example', status: 'bounced' }],
      });

      expect(result.suppressed).toBe(1);
      expect(await suppressed('dead@dispatch.example')).toBe(true);
    });

    it('NEVER puts an imported complaint on the global suppression list', async () => {
      // Settled by ADR-018: a complaint about one publication says nothing
      // about the others.
      await importer().execute({
        newsletterId,
        rows: [
          { email: 'angry@dispatch.example', status: 'complained' },
          { email: 'gone@dispatch.example', status: 'unsubscribed' },
        ],
      });

      expect(await suppressed('angry@dispatch.example')).toBe(false);
      expect(await suppressed('gone@dispatch.example')).toBe(false);
    });

    it('suppresses a bounced address even when its membership row is skipped', async () => {
      // `onConflict` governs this newsletter's row; skipping it does not make
      // the mailbox any less dead.
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'dead@dispatch.example', doubleOptIn: false });

      const result = await importer().execute({
        newsletterId,
        rows: [{ email: 'dead@dispatch.example', status: 'bounced' }],
      });

      expect(result.skipped).toBe(1);
      expect(result.suppressed).toBe(1);
      expect(await suppressed('dead@dispatch.example')).toBe(true);
    });

    it('excludes everything but subscribed rows from the resolved recipients', async () => {
      await importer().execute({
        newsletterId,
        rows: [
          { email: 'a@dispatch.example', status: 'subscribed' },
          { email: 'b@dispatch.example', status: 'pending' },
          { email: 'c@dispatch.example', status: 'unsubscribed' },
          { email: 'd@dispatch.example', status: 'bounced' },
          { email: 'e@dispatch.example', status: 'complained' },
        ],
      });

      const recipients = await container
        .get<ResolveRecipients>(SUBSCRIPTION_TYPES.ResolveRecipients)
        .execute(newsletterId);

      expect(recipients.map((r) => r.address)).toEqual(['a@dispatch.example']);
    });

    it('records where an imported row came from', async () => {
      // Without this, an inherited consent claim and one cablegram witnessed
      // itself are indistinguishable in the data — which is the half of the
      // consent record `subscribedAt` alone does not cover.
      await importer().execute({
        newsletterId,
        source: 'mailchimp-export-2026-07',
        rows: [
          { email: 'a@dispatch.example' },
          { email: 'b@dispatch.example', source: 'campaign-monitor-2021' },
        ],
      });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows.find((s) => s.email === 'a@dispatch.example')?.source).toBe(
        'mailchimp-export-2026-07',
      );
      // A per-row column beats the batch note.
      expect(rows.find((s) => s.email === 'b@dispatch.example')?.source).toBe(
        'campaign-monitor-2021',
      );
    });

    it('marks a row as imported even when no source was named', async () => {
      // The property has to hold unconditionally: one that only holds when the
      // operator remembers a flag is not a property you can audit against.
      await importer().execute({ newsletterId, rows: [{ email: 'a@dispatch.example' }] });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.source).toBe('import');
    });

    it('leaves a natively-collected subscription with no source at all', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.source).toBeUndefined();
    });

    it('keeps the source as a historical fact when the row is later re-subscribed', async () => {
      // A re-subscribe records "they since re-opted in" in the status and
      // `updatedAt`; it does not rewrite where the row came from.
      await importer().execute({
        newsletterId,
        source: 'mailchimp-export-2026-07',
        rows: [{ email: 'reader@dispatch.example', status: 'unsubscribed' }],
      });

      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.status).toBe('subscribed');
      expect(rows[0]?.source).toBe('mailchimp-export-2026-07');
    });

    it('re-stamps the source when overwrite replaces an existing row', async () => {
      await importer().execute({
        newsletterId,
        source: 'first-pass',
        rows: [{ email: 'a@dispatch.example' }],
      });

      await importer().execute({
        newsletterId,
        onConflict: 'overwrite',
        source: 'second-pass',
        rows: [{ email: 'a@dispatch.example' }],
      });

      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(rows[0]?.source).toBe('second-pass');
    });

    it('reports what the batch did, for progress and the dry-run summary', async () => {
      const result = await importer().execute({
        newsletterId,
        rows: [
          { email: 'a@dispatch.example', status: 'subscribed' },
          { email: 'b@dispatch.example', status: 'unsubscribed' },
        ],
      });

      expect(result).toMatchObject({
        received: 2,
        created: 2,
        updated: 0,
        skipped: 0,
        suppressed: 0,
      });
      expect(result.byStatus).toMatchObject({ subscribed: 1, unsubscribed: 1, bounced: 0 });
    });

    it('rejects an import into a newsletter that does not exist', async () => {
      await expect(
        importer().execute({ newsletterId: 'missing', rows: [{ email: 'a@dispatch.example' }] }),
      ).rejects.toBeInstanceOf(SubscriptionNewsletterNotFoundError);
    });

    it('rejects a malformed address rather than storing it', async () => {
      await expect(
        importer().execute({ newsletterId, rows: [{ email: 'not-an-email' }] }),
      ).rejects.toBeInstanceOf(InvalidSubscriptionEmailError);
    });
  });

  describe('provider-driven outcomes (ADR-018)', () => {
    it('marks a membership bounced by address, quietly ignoring unknown ones', async () => {
      const { id } = await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      const mark = container.get<MarkSubscriptionOutcome>(
        SUBSCRIPTION_TYPES.MarkSubscriptionOutcome,
      );

      expect(await mark.execute(newsletterId, 'reader@dispatch.example', 'bounced')).toBe(true);
      // A webhook for a since-deleted row is a race, not a fault — it must not
      // throw, or Postmark retries the event for hours.
      expect(await mark.execute(newsletterId, 'nobody@dispatch.example', 'bounced')).toBe(false);

      const found = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(found.find((r) => r.id === id)?.status).toBe('bounced');
    });

    it('is idempotent — a replayed webhook reports no change', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      const mark = container.get<MarkSubscriptionOutcome>(
        SUBSCRIPTION_TYPES.MarkSubscriptionOutcome,
      );

      expect(await mark.execute(newsletterId, 'reader@dispatch.example', 'complained')).toBe(true);
      expect(await mark.execute(newsletterId, 'reader@dispatch.example', 'complained')).toBe(false);
    });

    it('does not let a later bounce overwrite an explicit unsubscribe', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      const mark = container.get<MarkSubscriptionOutcome>(
        SUBSCRIPTION_TYPES.MarkSubscriptionOutcome,
      );

      await mark.execute(newsletterId, 'reader@dispatch.example', 'unsubscribed');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'bounced');

      // Someone who opted out and later bounces is still, primarily, someone
      // who opted out — that intent outranks a delivery failure.
      const found = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      expect(found[0]?.status).toBe('unsubscribed');
    });

    it('allows a re-subscribe from bounced and from complained', async () => {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      const mark = container.get<MarkSubscriptionOutcome>(
        SUBSCRIPTION_TYPES.MarkSubscriptionOutcome,
      );
      await mark.execute(newsletterId, 'reader@dispatch.example', 'bounced');

      // Mailboxes get fixed and people genuinely re-opt-in; for a hard bounce
      // the GLOBAL suppression list is the real gate, so reviving the row here
      // cannot actually put mail back on the wire.
      const revived = await container.get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe).execute({
        newsletterId,
        email: 'reader@dispatch.example',
        doubleOptIn: false,
      });
      expect(revived.status).toBe('subscribed');
    });
  });

  // ADR-020. Postmark retries internally before reporting a soft bounce, so
  // each one already represents a failed retry cycle — but one is still not
  // proof the mailbox is gone. Only repetition is a verdict.
  describe('soft-bounce streak (ADR-020)', () => {
    async function subscribed(email = 'reader@dispatch.example') {
      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email, doubleOptIn: false });
      return container.get<MarkSubscriptionOutcome>(SUBSCRIPTION_TYPES.MarkSubscriptionOutcome);
    }

    async function statusOf(email = 'reader@dispatch.example') {
      const rows = await container
        .get<ListSubscriptions>(SUBSCRIPTION_TYPES.ListSubscriptions)
        .execute({ newsletterId, limit: 10 });
      return rows.find((r) => r.email === email)?.status;
    }

    it('leaves the membership sendable below the threshold', async () => {
      const mark = await subscribed();

      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');

      // A full inbox drains and a downed server comes back — two is not a verdict.
      expect(await statusOf()).toBe('subscribed');
    });

    it('marks bounced at the threshold (default 3)', async () => {
      const mark = await subscribed();

      for (let i = 0; i < 3; i += 1) {
        await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      }

      expect(await statusOf()).toBe('bounced');
    });

    it('resets the streak on a delivery, so it must be CONSECUTIVE', async () => {
      const mark = await subscribed();

      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      // The mailbox demonstrably works again — whatever was wrong is over.
      await mark.execute(newsletterId, 'reader@dispatch.example', 'delivered');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');

      // Four soft bounces total, but never three in a row.
      expect(await statusOf()).toBe('subscribed');
    });

    it('skips the write when a delivery has no streak to clear', async () => {
      const mark = await subscribed();

      // Fires once per delivered recipient — ~18k times per send — so the
      // common no-op path must not cost a write.
      expect(await mark.execute(newsletterId, 'reader@dispatch.example', 'delivered')).toBe(false);
    });

    it('does not escalate an already-unsubscribed membership', async () => {
      const mark = await subscribed();
      await mark.execute(newsletterId, 'reader@dispatch.example', 'unsubscribed');

      for (let i = 0; i < 5; i += 1) {
        await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      }

      // Opt-out intent outranks a delivery failure; nothing left to escalate.
      expect(await statusOf()).toBe('unsubscribed');
    });

    it('clears the streak when the membership is revived', async () => {
      const mark = await subscribed();
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');
      await mark.execute(newsletterId, 'reader@dispatch.example', 'unsubscribed');

      await container
        .get<Subscribe>(SUBSCRIPTION_TYPES.Subscribe)
        .execute({ newsletterId, email: 'reader@dispatch.example', doubleOptIn: false });
      // A fresh start: the old streak is not evidence against the new membership.
      await mark.execute(newsletterId, 'reader@dispatch.example', 'soft-bounce');

      expect(await statusOf()).toBe('subscribed');
    });

  });
});

