// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here. Also
// covers `listDue` — the hardening-chunk scheduling seam (ADR-009).
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Campaign } from '../domain/campaign.js';
import { PrismaCampaignRepository } from './prisma-campaign-repository.js';

describe('PrismaCampaignRepository (contract)', () => {
  let prisma: PrismaClient;
  let repo: PrismaCampaignRepository;
  const newsletterId = 'nl-1';
  const t0 = new Date('2026-01-01T00:00:00Z');

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: inject('mongoUri') });
    repo = new PrismaCampaignRepository(prisma);
  });

  afterEach(async () => {
    await prisma.campaign.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function make(overrides: Partial<{ nlId: string; status: 'draft' | 'scheduled'; scheduledAt: Date | null }> = {}) {
    const campaign = Campaign.create({
      id: newId(),
      newsletterId: overrides.nlId ?? newsletterId,
      name: 'March Dispatch',
      templateId: 'tpl-1',
      scheduledAt: overrides.scheduledAt,
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

  describe('listDue (the dispatch-due seam)', () => {
    it('returns only scheduled campaigns whose scheduledAt has passed, oldest first', async () => {
      const due1 = make({ scheduledAt: new Date('2026-01-01T01:00:00Z') });
      const due2 = make({ scheduledAt: new Date('2026-01-01T02:00:00Z') });
      const notYetDue = make({ scheduledAt: new Date('2026-01-01T10:00:00Z') });
      const notScheduled = make();
      for (const c of [due2, due1, notYetDue, notScheduled]) await repo.create(c);

      const due = await repo.listDue(new Date('2026-01-01T03:00:00Z'), 10);
      expect(due.map((c) => c.id)).toEqual([due1.id, due2.id]);
    });

    it('caps at the given limit', async () => {
      const scheduledAt = new Date('2026-01-01T01:00:00Z');
      for (let i = 0; i < 3; i += 1) {
        await repo.create(make({ scheduledAt }));
      }
      const due = await repo.listDue(new Date('2026-01-01T02:00:00Z'), 2);
      expect(due).toHaveLength(2);
    });

    it('never returns a campaign whose status has moved past scheduled', async () => {
      const campaign = make({ scheduledAt: new Date('2026-01-01T01:00:00Z') });
      await repo.create(campaign);
      campaign.markSending('send-1', new Date('2026-01-01T01:30:00Z'));
      await repo.update(campaign);

      const due = await repo.listDue(new Date('2026-01-01T02:00:00Z'), 10);
      expect(due).toEqual([]);
    });
  });
});
