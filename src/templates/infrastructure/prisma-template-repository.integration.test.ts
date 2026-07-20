// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '../../shared/ids/index.js';
import { Template } from '../domain/template.js';
import { PrismaTemplateRepository } from './prisma-template-repository.js';

describe('PrismaTemplateRepository (contract)', () => {
  let prisma: PrismaClient;
  let repo: PrismaTemplateRepository;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: inject('mongoUri') });
    repo = new PrismaTemplateRepository(prisma);
  });

  afterEach(async () => {
    await prisma.template.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function make() {
    return Template.create({
      id: newId(),
      name: 'Shell',
      subject: 'Hello {{firstName}}',
      bodyHtml: '<h1>Hello {{firstName}}</h1>',
      bodyText: 'Hello {{firstName}}',
      now: new Date('2026-01-01T00:00:00Z'),
    });
  }

  it('creates and finds by id, round-tripping every field including a null bodyText', async () => {
    const withText = make();
    await repo.create(withText);
    const found = await repo.findById(withText.id);
    expect(found?.subject).toBe('Hello {{firstName}}');
    expect(found?.bodyText).toBe('Hello {{firstName}}');

    const noText = Template.create({
      id: newId(),
      name: 'No text',
      subject: 'S',
      bodyHtml: '<p>H</p>',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.create(noText);
    expect((await repo.findById(noText.id))?.bodyText).toBeNull();
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
    const template = make();
    await repo.create(template);
    template.update({ subject: 'Updated' }, new Date('2026-02-01T00:00:00Z'));
    await repo.update(template);
    expect((await repo.findById(template.id))?.subject).toBe('Updated');
  });

  it('deletes, returning true once and false thereafter', async () => {
    const template = make();
    await repo.create(template);
    expect(await repo.delete(template.id)).toBe(true);
    expect(await repo.delete(template.id)).toBe(false);
  });
});
