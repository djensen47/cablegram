// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Send } from '../domain/send.js';
import { MongoSendRepository } from './mongo-send-repository.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';

describe('MongoSendRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoSendRepository;

  const campaignId = 'camp-1';
  const t0 = new Date('2026-01-01T00:00:00Z');
  const t1 = new Date('2026-01-01T01:00:00Z');

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoSendRepository(db);
  });

  afterEach(async () => {
    await db.collection(CAMPAIGN_COLLECTIONS.sends).deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  function make(recipientCount = 3): Send {
    return Send.create({ id: newId(), campaignId, recipientCount, now: t0 });
  }

  it('round-trips a send', async () => {
    const send = make();
    await repo.create(send);

    const found = await repo.findById(send.id);
    expect(found?.campaignId).toBe(campaignId);
    expect(found?.recipientCount).toBe(3);
    expect(found?.bulkRequestId).toBeNull();
    expect(found?.submittedAt).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });

  it('persists the provider acknowledgement', async () => {
    const send = make();
    await repo.create(send);

    send.markSubmitted('bulk-req-1', t1, t1);
    await repo.update(send);

    const found = await repo.findById(send.id);
    expect(found?.bulkRequestId).toBe('bulk-req-1');
    expect(found?.submittedAt).toEqual(t1);
  });

  it('keeps the document small and free of a recipient array', async () => {
    // The point of ADR-019: no embedded per-recipient ledger, so this document
    // does not grow with the size of the list and can never approach the 16 MB
    // BSON ceiling.
    const send = make(18_000);
    await repo.create(send);

    const doc = await db
      .collection<{ _id: string; recipientCount: number }>(CAMPAIGN_COLLECTIONS.sends)
      .findOne({ _id: send.id });
    expect(doc).not.toBeNull();
    expect(doc).not.toHaveProperty('outcomes');
    expect(doc).not.toHaveProperty('appliedEvents');
    expect(doc?.recipientCount).toBe(18_000);
  });
});
