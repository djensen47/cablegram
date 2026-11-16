// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Campaign, SENDABLE_STATUSES } from '../domain/campaign.js';
import { MongoCampaignRepository } from './mongo-campaign-repository.js';
import { CAMPAIGN_COLLECTIONS } from './collections.js';

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
    await db.collection(CAMPAIGN_COLLECTIONS.campaigns).deleteMany({});
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
    expect(found?.recipientCount).toBe(campaign.recipientCount);
  });

  it('updates in place, including a status transition and recipientCount', async () => {
    const campaign = make();
    await repo.create(campaign);

    campaign.markSending('send-1', new Date('2026-01-02T00:00:00Z'));
    await repo.update(campaign);
    expect((await repo.findById(campaign.id))?.status).toBe('sending');

    campaign.markSent(2, new Date('2026-01-03T00:00:00Z'));
    await repo.update(campaign);
    const sent = await repo.findById(campaign.id);
    expect(sent?.status).toBe('sent');
    expect(sent?.recipientCount).toBe(2);
    expect(sent?.sentAt).toEqual(new Date('2026-01-03T00:00:00Z'));
  });

  // The conditional write (ADR-035). The last test is the reason it exists, and
  // it can only be shown here: a single-threaded double cannot lose a race.
  describe('saveIfStatus', () => {
    it('writes when the stored status is one of `from`', async () => {
      const campaign = make();
      await repo.create(campaign);

      campaign.markSending('send-1', new Date('2026-01-02T00:00:00Z'));
      expect(await repo.saveIfStatus(campaign, SENDABLE_STATUSES)).toBe(true);

      const stored = await repo.findById(campaign.id);
      expect(stored?.status).toBe('sending');
      expect(stored?.sendId).toBe('send-1');
    });

    it('writes nothing and returns false when the stored status is not', async () => {
      const campaign = make();
      await repo.create(campaign);
      campaign.markSending('send-1', new Date('2026-01-02T00:00:00Z'));
      await repo.saveIfStatus(campaign, SENDABLE_STATUSES);

      // A second request that still holds the `draft` it read earlier.
      const stale = make();
      const late = Campaign.reconstitute({
        id: campaign.id,
        newsletterId,
        name: 'Edited too late',
        templateId: 'tpl-1',
        subject: null,
        bodyHtml: null,
        bodyText: null,
        segmentTags: [],
        status: 'draft',
        sendId: null,
        recipientCount: 0,
        createdAt: stale.createdAt,
        updatedAt: new Date('2026-01-02T00:00:01Z'),
        sentAt: null,
      });
      expect(await repo.saveIfStatus(late, SENDABLE_STATUSES)).toBe(false);

      const stored = await repo.findById(campaign.id);
      expect(stored?.status).toBe('sending');
      expect(stored?.name).toBe('March Dispatch');
    });

    it('returns false for a row that does not exist', async () => {
      expect(await repo.saveIfStatus(make(), SENDABLE_STATUSES)).toBe(false);
    });

    it('lets exactly one of two concurrent claims through', async () => {
      const campaign = make();
      await repo.create(campaign);

      // Two requests, each with its own read of the same `draft`.
      const a = (await repo.findById(campaign.id))!;
      const b = (await repo.findById(campaign.id))!;
      a.markSending('send-a', new Date('2026-01-02T00:00:00Z'));
      b.markSending('send-b', new Date('2026-01-02T00:00:00Z'));

      const [wonA, wonB] = await Promise.all([
        repo.saveIfStatus(a, SENDABLE_STATUSES),
        repo.saveIfStatus(b, SENDABLE_STATUSES),
      ]);

      expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
      expect((await repo.findById(campaign.id))?.sendId).toBe(wonA ? 'send-a' : 'send-b');
    });
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
