// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Campaign } from '../domain/campaign.js';
import { MongoCampaignRepository } from './mongo-campaign-repository.js';

describe('MongoCampaignRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoCampaignRepository;
  const newsletterId = 'nl-1';
  const t0 = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoCampaignRepository(db);
  });

  afterEach(async () => {
    await db.collection('campaigns').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  function make(overrides: Partial<{ nlId: string }> = {}) {
    const campaign = Campaign.create({
      id: newId(),
      newsletterId: overrides.nlId ?? newsletterId,
      name: 'March Dispatch',
      templateId: 'tpl-1',
      now: t0,
    });
    return campaign;
  }

  it('creates and finds by id, round-tripping stats and content fields', async () => {
    const campaign = make();
    await repo.create(campaign);

    const found = await repo.findById(campaign.id);
    expect(found?.name).toBe('March Dispatch');
    expect(found?.templateId).toBe('tpl-1');
    expect(found?.status).toBe('draft');
    expect(found?.stats).toEqual(campaign.stats);
  });

  it('updates in place, including a status transition and stats', async () => {
    const campaign = make();
    await repo.create(campaign);

    campaign.markSending('send-1', new Date('2026-01-02T00:00:00Z'));
    await repo.update(campaign);
    expect((await repo.findById(campaign.id))?.status).toBe('sending');

    campaign.markSent(
      { recipients: 2, accepted: 2, rejected: 0, delivered: 0, bounced: 0, complained: 0 },
      new Date('2026-01-03T00:00:00Z'),
    );
    await repo.update(campaign);
    const sent = await repo.findById(campaign.id);
    expect(sent?.status).toBe('sent');
    expect(sent?.stats.accepted).toBe(2);
    expect(sent?.sentAt).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  it('lists id-ordered, filtered by newsletterId and status', async () => {
    const a = make();
    const b = make({ nlId: 'nl-2' });
    await repo.create(a);
    await repo.create(b);

    const scoped = await repo.list({ newsletterId, limit: 10 });
    expect(scoped.map((c) => c.id)).toEqual([a.id]);

    const byStatus = await repo.list({ status: 'draft', limit: 10 });
    expect(byStatus.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('deletes, returning true once and false thereafter', async () => {
    const campaign = make();
    await repo.create(campaign);
    expect(await repo.delete(campaign.id)).toBe(true);
    expect(await repo.delete(campaign.id)).toBe(false);
  });
});
