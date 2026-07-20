// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { SuppressionEntry } from '../domain/suppression.js';
import { PrismaSuppressionRepository } from './prisma-suppression-repository.js';

describe('PrismaSuppressionRepository (contract)', () => {
  let prisma: PrismaClient;
  let repo: PrismaSuppressionRepository;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: inject('mongoUri') });
    repo = new PrismaSuppressionRepository(prisma);
  });

  afterEach(async () => {
    await prisma.suppression.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('adds and finds by address (the address IS the id, ADR-011)', async () => {
    const entry = SuppressionEntry.create({
      address: 'bounced@dispatch.example',
      reason: 'hard-bounce',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.add(entry);

    const found = await repo.findByAddress('bounced@dispatch.example');
    expect(found?.reason).toBe('hard-bounce');
  });

  it('is idempotent: re-adding an already-suppressed address leaves the original reason untouched', async () => {
    const first = SuppressionEntry.create({
      address: 'bounced@dispatch.example',
      reason: 'hard-bounce',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.add(first);

    const second = SuppressionEntry.create({
      address: 'bounced@dispatch.example',
      reason: 'manual-junk',
      now: new Date('2026-02-01T00:00:00Z'),
    });
    const result = await repo.add(second);

    expect(result.reason).toBe('hard-bounce');
    expect((await repo.findByAddress('bounced@dispatch.example'))?.reason).toBe('hard-bounce');
  });

  it('lists address-ordered with exclusive-cursor pagination', async () => {
    for (const address of ['c@dispatch.example', 'a@dispatch.example', 'b@dispatch.example']) {
      await repo.add(
        SuppressionEntry.create({ address, reason: 'manual-junk', now: new Date('2026-01-01T00:00:00Z') }),
      );
    }

    const firstPage = await repo.list({ limit: 2 });
    expect(firstPage.map((e) => e.address)).toEqual(['a@dispatch.example', 'b@dispatch.example']);
    const secondPage = await repo.list({ limit: 2, cursor: 'b@dispatch.example' });
    expect(secondPage.map((e) => e.address)).toEqual(['c@dispatch.example']);
  });

  it('removes, returning true once and false thereafter', async () => {
    await repo.add(
      SuppressionEntry.create({
        address: 'bounced@dispatch.example',
        reason: 'hard-bounce',
        now: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    expect(await repo.remove('bounced@dispatch.example')).toBe(true);
    expect(await repo.remove('bounced@dispatch.example')).toBe(false);
  });

  it('filterSuppressed returns only the suppressed subset of a batch', async () => {
    await repo.add(
      SuppressionEntry.create({
        address: 'bounced@dispatch.example',
        reason: 'hard-bounce',
        now: new Date('2026-01-01T00:00:00Z'),
      }),
    );

    const result = await repo.filterSuppressed([
      'bounced@dispatch.example',
      'clean@dispatch.example',
    ]);
    expect(result).toEqual(['bounced@dispatch.example']);
    expect(await repo.filterSuppressed([])).toEqual([]);
  });
});
