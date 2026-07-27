// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Subscription } from '../domain/subscription.js';
import { MongoSubscriptionRepository } from './mongo-subscription-repository.js';
import { SUBSCRIPTION_COLLECTIONS } from './collections.js';

describe('MongoSubscriptionRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoSubscriptionRepository;
  const newsletterId = 'nl-1';

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoSubscriptionRepository(db);
  });

  afterEach(async () => {
    await db.collection(SUBSCRIPTION_COLLECTIONS.subscriptions).deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  function make(
    email: string,
    overrides: Partial<{ tags: string[]; doubleOptIn: boolean; nlId: string }> = {},
  ) {
    return Subscription.create({
      id: newId(),
      newsletterId: overrides.nlId ?? newsletterId,
      email,
      tags: overrides.tags,
      doubleOptIn: overrides.doubleOptIn ?? false,
      now: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it('creates and finds by id and by (newsletterId, email) — the compound membership key', async () => {
    const sub = make('reader@dispatch.example');
    await repo.create(sub);

    expect((await repo.findById(sub.id))?.email).toBe('reader@dispatch.example');
    const byCompound = await repo.findByNewsletterAndEmail(newsletterId, 'reader@dispatch.example');
    expect(byCompound?.id).toBe(sub.id);
    expect(await repo.findByNewsletterAndEmail(newsletterId, 'nobody@dispatch.example')).toBeNull();
  });

  it('enforces the (newsletterId, email) unique index — a duplicate create is rejected', async () => {
    await repo.create(make('reader@dispatch.example'));
    await expect(repo.create(make('reader@dispatch.example'))).rejects.toThrow();
  });

  it('allows the same email across two different newsletters (no cross-newsletter Contact, ADR-011)', async () => {
    await repo.create(make('reader@dispatch.example', { nlId: 'nl-1' }));
    await expect(repo.create(make('reader@dispatch.example', { nlId: 'nl-2' }))).resolves.toBeUndefined();
  });

  it('finds a whole batch by (newsletterId, emails) — the import path’s single read', async () => {
    await repo.create(make('a@dispatch.example'));
    await repo.create(make('b@dispatch.example'));
    await repo.create(make('other@dispatch.example', { nlId: 'nl-2' }));

    const found = await repo.findByNewsletterAndEmails(newsletterId, [
      'a@dispatch.example',
      'b@dispatch.example',
      'missing@dispatch.example',
      // Same address, different newsletter: must not leak across (ADR-011).
      'other@dispatch.example',
    ]);

    expect(found.map((s) => s.email).sort()).toEqual(['a@dispatch.example', 'b@dispatch.example']);
    expect(await repo.findByNewsletterAndEmails(newsletterId, [])).toEqual([]);
  });

  it('saves a batch, inserting new rows and replacing existing ones by id', async () => {
    const existing = make('a@dispatch.example');
    await repo.create(existing);
    existing.overwriteFromImport({ status: 'unsubscribed', now: new Date('2026-03-01T00:00:00Z') });
    const fresh = make('b@dispatch.example');

    await repo.saveMany([existing, fresh]);

    expect((await repo.findById(existing.id))?.status).toBe('unsubscribed');
    expect((await repo.findById(fresh.id))?.email).toBe('b@dispatch.example');
    // Replaced, not duplicated — the compound key still holds one row.
    const all = await repo.list({ newsletterId, limit: 10 });
    expect(all).toHaveLength(2);
    expect(await repo.saveMany([])).toBeUndefined();
  });

  it('rejects a batch that would violate the (newsletterId, email) unique index', async () => {
    // A concurrent import racing on the same address must fail loudly rather
    // than silently producing two memberships for one person.
    await repo.create(make('a@dispatch.example'));

    await expect(repo.saveMany([make('a@dispatch.example')])).rejects.toThrow();
  });

  it('preserves an imported opt-in date through a round trip', async () => {
    const subscribedAt = new Date('2019-04-02T09:15:00.000Z');
    const imported = Subscription.import({
      id: newId(),
      newsletterId,
      email: 'legacy@dispatch.example',
      status: 'unsubscribed',
      subscribedAt,
      now: new Date('2026-01-01T00:00:00Z'),
    });

    await repo.saveMany([imported]);

    const stored = await repo.findById(imported.id);
    expect(stored?.createdAt).toEqual(subscribedAt);
    expect(stored?.status).toBe('unsubscribed');
  });

  it('updates in place', async () => {
    const sub = make('reader@dispatch.example');
    await repo.create(sub);
    sub.unsubscribe(new Date('2026-02-01T00:00:00Z'));
    await repo.update(sub);
    expect((await repo.findById(sub.id))?.status).toBe('unsubscribed');
  });

  it('lists id-ordered, scoped to one newsletter, with a tag filter and exclusive-cursor pagination', async () => {
    const inScope = [
      make('a@dispatch.example', { tags: ['vip'] }),
      make('b@dispatch.example'),
      make('c@dispatch.example', { tags: ['vip'] }),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const sub of inScope) await repo.create(sub);
    await repo.create(make('other@dispatch.example', { nlId: 'nl-other' }));

    const all = await repo.list({ newsletterId, limit: 10 });
    expect(all).toHaveLength(3);

    const vipOnly = await repo.list({ newsletterId, tag: 'vip', limit: 10 });
    expect(vipOnly.map((s) => s.email).sort()).toEqual(['a@dispatch.example', 'c@dispatch.example']);

    const firstPage = await repo.list({ newsletterId, limit: 2 });
    const secondPage = await repo.list({ newsletterId, limit: 2, cursor: firstPage[1]?.id });
    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);
  });

  it('resolveRecipients returns only subscribed rows, narrowed by an AND tag segment', async () => {
    await repo.create(make('vip@dispatch.example', { tags: ['vip', 'beta'] }));
    await repo.create(make('plain@dispatch.example', { tags: ['beta'] }));
    await repo.create(make('pending@dispatch.example', { doubleOptIn: true }));

    const all = await repo.resolveRecipients(newsletterId);
    expect(all.map((r) => r.address).sort()).toEqual(['plain@dispatch.example', 'vip@dispatch.example']);

    const vipSegment = await repo.resolveRecipients(newsletterId, { tags: ['vip'] });
    expect(vipSegment.map((r) => r.address)).toEqual(['vip@dispatch.example']);
    // The projection carries the subscription id (from `_id`) so the send path
    // can mint a per-recipient unsubscribe token (ADR-015).
    const vip = await repo.findByNewsletterAndEmail(newsletterId, 'vip@dispatch.example');
    expect(vipSegment[0]?.subscriptionId).toBe(vip?.id);
  });
});
