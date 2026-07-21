// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { SendRecord } from '../domain/send-record.js';
import { MongoSendRecordRepository } from './mongo-send-record-repository.js';

describe('MongoSendRecordRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoSendRecordRepository;

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoSendRecordRepository(db);
  });

  afterEach(async () => {
    await db.collection('send_records').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  function make() {
    return SendRecord.create({
      id: newId(),
      campaignId: 'campaign-1',
      addresses: ['a@dispatch.example', 'b@dispatch.example'],
      now: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it('creates and finds by id, round-tripping the opaque outcomes array', async () => {
    const record = make();
    await repo.create(record);

    const found = await repo.findById(record.id);
    expect(found?.campaignId).toBe('campaign-1');
    expect(found?.outcomes).toHaveLength(2);
    expect(found?.outcomes.map((o) => o.address).sort()).toEqual([
      'a@dispatch.example',
      'b@dispatch.example',
    ]);
    expect(found?.outcomes[0]?.status).toBe('pending');
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findById('does-not-exist')).toBeNull();
  });

  it('updates in place after submitting and applying delivery events', async () => {
    const record = make();
    await repo.create(record);

    // Async bulk submit: stamp the request id + raise recipients to `accepted`.
    record.markSubmitted(
      'bulk-req-1',
      new Date('2026-01-01T00:00:30Z'),
      new Date('2026-01-01T00:01:00Z'),
    );
    // A delivery webhook matches by address (bulk returns no per-recipient ids).
    record.applyEvent(
      { type: 'delivered', address: 'a@dispatch.example', messageId: 'm-1' },
      new Date('2026-01-01T00:02:00Z'),
    );
    await repo.update(record);

    const found = await repo.findById(record.id);
    expect(found?.bulkRequestId).toBe('bulk-req-1');
    expect(found?.submittedAt).toEqual(new Date('2026-01-01T00:00:30Z'));
    const byAddress = Object.fromEntries(found?.outcomes.map((o) => [o.address, o.status]) ?? []);
    expect(byAddress['a@dispatch.example']).toBe('delivered');
    expect(byAddress['b@dispatch.example']).toBe('accepted');
    expect(found?.appliedEvents).toEqual(['m-1:delivered']);
  });
});
