// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
//
// This suite carries more weight than most: the behaviors it pins (atomicity
// under concurrency, only-ever-raise, dedupe) are precisely what the previous
// embedded-array design got wrong, and they are **not** observable from the
// unit suite, which runs single-threaded against an in-memory double.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { RecipientOutcome, effectOf } from '../domain/recipient-outcome.js';
import { MongoRecipientOutcomeRepository } from './mongo-recipient-outcome-repository.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';

describe('MongoRecipientOutcomeRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoRecipientOutcomeRepository;

  const sendId = 'send-1';
  const campaignId = 'camp-1';
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T01:00:00Z');

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoRecipientOutcomeRepository(db);
  });

  afterEach(async () => {
    await db.collection(CAMPAIGN_COLLECTIONS.recipientOutcomes).deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  const address = (n: number): string => `r${n}@dispatch.example`;

  async function open(count: number): Promise<void> {
    await repo.createMany(
      Array.from({ length: count }, (_, i) =>
        RecipientOutcome.create({
          id: newId(),
          sendId,
          campaignId,
          address: address(i),
          now: t0,
        }),
      ),
    );
  }

  /** The row for one address — ids are random, so never rely on list order. */
  async function rowFor(to: string) {
    const rows = await repo.list({ sendId, limit: 100 });
    return rows.find((r) => r.address === to);
  }

  /** Build the repository-level event the use case would produce. */
  function event(type: string, to: string, occurredAt: Date | null = t1) {
    const { effect, dedupeKey } = effectOf({ type, address: to, messageId: `m-${to}`, occurredAt });
    return { sendId, address: to, effect, dedupeKey, now: t1 };
  }

  beforeEach(async () => {
    await open(3);
  });

  it('opens one row per recipient, all pending', async () => {
    const rows = await repo.list({ sendId, limit: 100 });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('raises every pending recipient to accepted in one bulk update', async () => {
    await repo.markAccepted(sendId, t1);

    const rows = await repo.list({ sendId, limit: 100 });
    expect(rows.every((r) => r.status === 'accepted')).toBe(true);
  });

  it('applies a delivery to exactly one recipient', async () => {
    await repo.markAccepted(sendId, t1);
    expect(await repo.applyEvent(event('delivered', address(0)))).toBe(true);

    const rows = await repo.list({ sendId, limit: 100 });
    const byAddress = Object.fromEntries(rows.map((r) => [r.address, r.status]));
    expect(byAddress[address(0)]).toBe('delivered');
    expect(byAddress[address(1)]).toBe('accepted');
  });

  it('is idempotent: a replayed webhook changes nothing', async () => {
    await repo.applyEvent(event('open', address(0)));
    // Postmark retries for hours on any non-200, so duplicates are routine.
    expect(await repo.applyEvent(event('open', address(0)))).toBe(false);

    const row = await rowFor(address(0));
    expect(row?.opens).toBe(1);
  });

  it('counts a genuine repeat open, discarding only the retry', async () => {
    // Regression: the old dedupe key was `<messageId>:open`, so the SECOND open
    // for a message was dropped and `opens` could never exceed 1 — a field
    // typed as a counter that behaved as a boolean.
    await repo.applyEvent(event('open', address(0), new Date('2026-01-01T01:00:00Z')));
    await repo.applyEvent(event('open', address(0), new Date('2026-01-01T02:00:00Z')));
    await repo.applyEvent(event('open', address(0), new Date('2026-01-01T02:00:00Z'))); // retry

    const row = await rowFor(address(0));
    expect(row?.opens).toBe(2);
  });

  it('only ever raises status — a late delivery cannot undo a bounce', async () => {
    await repo.applyEvent(event('hard-bounce', address(0)));
    // Out-of-order arrival is normal; it must converge, not flap.
    expect(await repo.applyEvent(event('delivered', address(0)))).toBe(false);

    const row = await rowFor(address(0));
    expect(row?.status).toBe('bounced');
  });

  it('raises to the more significant status regardless of arrival order', async () => {
    await repo.applyEvent(event('delivered', address(0)));
    expect(await repo.applyEvent(event('spam-complaint', address(0)))).toBe(true);

    const row = await rowFor(address(0));
    expect(row?.status).toBe('complained');
  });

  it('does not lose updates when many webhooks land concurrently', async () => {
    // THE regression this redesign exists for. The previous implementation read
    // a whole multi-megabyte send record, mutated an embedded array, and
    // replaceOne'd it back with no optimistic concurrency — so concurrent
    // webhooks each wrote a document built from a stale read and silently
    // erased one another. Here every write is one atomic single-document
    // update, so all 3 land.
    await repo.markAccepted(sendId, t1);

    await Promise.all([
      repo.applyEvent(event('delivered', address(0))),
      repo.applyEvent(event('delivered', address(1))),
      repo.applyEvent(event('hard-bounce', address(2))),
    ]);

    const stats = await repo.stats(sendId);
    expect(stats).toMatchObject({ recipients: 3, delivered: 2, bounced: 1 });
  });

  it('does not lose concurrent opens on the same recipient', async () => {
    const opens = Array.from({ length: 20 }, (_, i) =>
      repo.applyEvent(event('open', address(0), new Date(Date.UTC(2026, 0, 1, 0, i)))),
    );
    await Promise.all(opens);

    const row = await rowFor(address(0));
    // $inc is atomic; a read-modify-write would have lost most of these.
    expect(row?.opens).toBe(20);
  });

  it('rejects a second row for the same (sendId, address)', async () => {
    // The unique index is what stops a send splitting one recipient's outcome
    // across two documents, which would double-count it in stats.
    await expect(
      repo.createMany([
        RecipientOutcome.create({
          id: newId(),
          sendId,
          campaignId,
          address: address(0),
          now: t0,
        }),
      ]),
    ).rejects.toThrow();
  });

  it('counts stats by status', async () => {
    await repo.markAccepted(sendId, t1);
    await repo.applyEvent(event('delivered', address(0)));
    await repo.applyEvent(event('hard-bounce', address(1)));

    expect(await repo.stats(sendId)).toMatchObject({
      recipients: 3,
      accepted: 3,
      delivered: 1,
      bounced: 1,
      complained: 0,
    });
  });

  it('filters a listing by status', async () => {
    await repo.applyEvent(event('hard-bounce', address(1)));

    const rows = await repo.list({ sendId, statuses: ['bounced'], limit: 100 });
    expect(rows.map((r) => r.address)).toEqual([address(1)]);
  });

  it('paginates forward by cursor without repeating a row', async () => {
    const first = await repo.list({ sendId, limit: 2 });
    const second = await repo.list({ sendId, limit: 2, cursor: first[1]?.id });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(3);
  });

  it('scopes everything to its own send', async () => {
    await repo.createMany([
      RecipientOutcome.create({
        id: newId(),
        sendId: 'other-send',
        campaignId,
        address: address(0),
        now: t0,
      }),
    ]);

    expect(await repo.list({ sendId, limit: 100 })).toHaveLength(3);
    expect((await repo.stats('other-send')).recipients).toBe(1);
  });
});
