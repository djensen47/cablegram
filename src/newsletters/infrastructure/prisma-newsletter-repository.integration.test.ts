// Repository contract test (docs/testing.md): run only via `npm run
// test:integration`, against a real `mongod` (mongodb-memory-server, a
// single-node replica set — ADR-007). Asserts the SAME behavioral contract
// the sibling `InMemoryNewsletterRepository` is exercised against in the
// default suite, so both are trusted stand-ins for `NewsletterRepository`.
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Newsletter } from '../domain/newsletter.js';
import { PrismaNewsletterRepository } from './prisma-newsletter-repository.js';

describe('PrismaNewsletterRepository (contract)', () => {
  let prisma: PrismaClient;
  let repo: PrismaNewsletterRepository;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: inject('mongoUri') });
    repo = new PrismaNewsletterRepository(prisma);
  });

  afterEach(async () => {
    await prisma.newsletter.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function make(overrides: Partial<{ name: string; fromEmail: string }> = {}) {
    return Newsletter.create({
      id: newId(),
      name: overrides.name ?? 'The Weekly Dispatch',
      fromName: 'Dispatch Editors',
      fromEmail: overrides.fromEmail ?? 'editors@dispatch.example',
      replyTo: 'replies@dispatch.example',
      sendingDomain: 'dispatch.example',
      dkimIdentifier: 'dkim1',
      now: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it('creates and finds by id, round-tripping every field', async () => {
    const newsletter = make();
    await repo.create(newsletter);

    const found = await repo.findById(newsletter.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(newsletter.id);
    expect(found?.name).toBe(newsletter.name);
    expect(found?.fromEmail.value).toBe('editors@dispatch.example');
    expect(found?.replyTo?.value).toBe('replies@dispatch.example');
    expect(found?.sendingDomain).toBe('dispatch.example');
    expect(found?.dkimIdentifier).toBe('dkim1');
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findById('does-not-exist')).toBeNull();
  });

  it('lists id-ordered with exclusive-cursor pagination', async () => {
    const rows = [make(), make(), make()].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const row of rows) await repo.create(row);

    const firstPage = await repo.list({ limit: 2 });
    expect(firstPage.map((r) => r.id)).toEqual(rows.slice(0, 2).map((r) => r.id));

    const secondPage = await repo.list({ limit: 2, cursor: firstPage[1]?.id });
    expect(secondPage.map((r) => r.id)).toEqual([rows[2]?.id]);
  });

  it('updates in place', async () => {
    const newsletter = make();
    await repo.create(newsletter);

    newsletter.update({ name: 'Renamed' }, new Date('2026-02-01T00:00:00Z'));
    await repo.update(newsletter);

    const found = await repo.findById(newsletter.id);
    expect(found?.name).toBe('Renamed');
  });

  it('deletes, returning true once and false thereafter', async () => {
    const newsletter = make();
    await repo.create(newsletter);

    expect(await repo.delete(newsletter.id)).toBe(true);
    expect(await repo.delete(newsletter.id)).toBe(false);
    expect(await repo.findById(newsletter.id)).toBeNull();
  });
});
