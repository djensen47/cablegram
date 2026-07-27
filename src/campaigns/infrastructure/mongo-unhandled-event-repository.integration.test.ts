// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { MongoUnhandledEventRepository } from './mongo-unhandled-event-repository.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';

describe('MongoUnhandledEventRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoUnhandledEventRepository;

  const t0 = new Date('2026-08-01T09:12:00Z');
  const t1 = new Date('2026-09-14T16:40:00Z');

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoUnhandledEventRepository(db);
  });

  afterEach(async () => {
    await db.collection(CAMPAIGN_COLLECTIONS.unhandledEvents).deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  it('opens a bucket on first sight', async () => {
    await repo.record({ key: 'SubscriptionChange', sample: '{"a":1}', now: t0 });

    expect(await repo.list()).toEqual([
      {
        key: 'SubscriptionChange',
        count: 1,
        sample: '{"a":1}',
        firstSeenAt: t0,
        lastSeenAt: t0,
      },
    ]);
  });

  it('counts repeats into the same document and keeps the first sample', async () => {
    await repo.record({ key: 'SubscriptionChange', sample: 'first', now: t0 });
    await repo.record({ key: 'SubscriptionChange', sample: 'second', now: t1 });
    await repo.record({ key: 'SubscriptionChange', sample: 'third', now: t1 });

    const [row] = await repo.list();
    expect(row).toEqual({
      key: 'SubscriptionChange',
      count: 3,
      // Pinned to the first payload: the row has to mean the same thing when
      // someone looks at it a week later.
      sample: 'first',
      firstSeenAt: t0,
      lastSeenAt: t1,
    });
  });

  it('stays one document per key no matter the volume', async () => {
    // The bound this whole design rests on. If it were one document per *event*
    // it would grow with traffic — 50k rows per send — and need a TTL and a
    // retention policy to stay safe. Keyed by type it needs neither.
    for (let i = 0; i < 50; i += 1) {
      await repo.record({ key: 'SubscriptionChange', sample: `s${i}`, now: t1 });
    }
    await repo.record({ key: '__unparseable', sample: 'junk', now: t1 });

    expect(await db.collection(CAMPAIGN_COLLECTIONS.unhandledEvents).countDocuments()).toBe(2);
  });

  it('lists most-frequent first', async () => {
    await repo.record({ key: 'rare', sample: 'x', now: t0 });
    await repo.record({ key: 'common', sample: 'x', now: t0 });
    await repo.record({ key: 'common', sample: 'x', now: t1 });

    expect((await repo.list()).map((r) => r.key)).toEqual(['common', 'rare']);
  });

  it('is empty when nothing has been dropped', async () => {
    // The healthy state, and the one the endpoint should report most of the time.
    expect(await repo.list()).toEqual([]);
  });

  it('does not lose concurrent increments', async () => {
    // `record` is an upsert with `$inc`, not a read-modify-write — the same
    // discipline as the per-recipient outcome writes (ADR-019). Concurrent
    // webhooks for one key must sum, not overwrite. Only provable against a
    // real server: a single-threaded double cannot interleave.
    await Promise.all(
      Array.from({ length: 25 }, () =>
        repo.record({ key: 'SubscriptionChange', sample: 'x', now: t1 }),
      ),
    );

    const [row] = await repo.list();
    expect(row?.count).toBe(25);
  });
});
