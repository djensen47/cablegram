import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import {
  TEMPLATE_TYPES,
  InMemoryTemplateRepository,
  CreateTemplate,
  GetTemplate,
  ListTemplates,
  UpdateTemplate,
  DeleteTemplate,
  InvalidTemplateError,
  TemplateNotFoundError,
  TemplateCompileError,
} from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// Rebind the repository token to the in-memory double (ADR-003); the rest of
// the container (use cases, the real Handlebars renderer, clock) is the real
// wiring.
function testContainer(): Container {
  const container = buildContainer(env);
  container.rebind(TEMPLATE_TYPES.TemplateRepository).to(InMemoryTemplateRepository);
  return container;
}

const validInput = {
  name: 'Weekly digest',
  subject: 'Your {{weekOf}} digest',
  bodyHtml: '<p>Hi {{firstName}}, here is your digest.</p>',
  bodyText: 'Hi {{firstName}}, here is your digest.',
};

describe('templates use cases', () => {
  let container: Container;

  beforeEach(() => {
    container = testContainer();
  });

  it('creates a template', async () => {
    const created = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute(validInput);

    expect(created.id).toBeTruthy();
    expect(created.bodyHtml).toBe(validInput.bodyHtml);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.createdAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it('rejects an empty name', async () => {
    await expect(
      container
        .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
        .execute({ ...validInput, name: '   ' }),
    ).rejects.toBeInstanceOf(InvalidTemplateError);
  });

  it('rejects malformed template syntax on create', async () => {
    await expect(
      container
        .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
        .execute({ ...validInput, bodyHtml: '<p>{{#if unterminated</p>' }),
    ).rejects.toBeInstanceOf(TemplateCompileError);
  });

  it('gets a template by id', async () => {
    const created = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute(validInput);

    const fetched = await container.get<GetTemplate>(TEMPLATE_TYPES.GetTemplate).execute(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(validInput.name);
  });

  it('throws TemplateNotFoundError for a missing id', async () => {
    await expect(
      container.get<GetTemplate>(TEMPLATE_TYPES.GetTemplate).execute('missing'),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('updates a template and bumps updatedAt', async () => {
    const created = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute(validInput);

    const updated = await container
      .get<UpdateTemplate>(TEMPLATE_TYPES.UpdateTemplate)
      .execute(created.id, { name: 'Renamed digest', bodyText: null });

    expect(updated.name).toBe('Renamed digest');
    expect(updated.bodyText).toBeNull();
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());
  });

  it('rejects malformed template syntax on update', async () => {
    const created = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute(validInput);

    await expect(
      container
        .get<UpdateTemplate>(TEMPLATE_TYPES.UpdateTemplate)
        .execute(created.id, { bodyHtml: '{{#each items}}unterminated' }),
    ).rejects.toBeInstanceOf(TemplateCompileError);
  });

  it('deletes a template, then reports it missing', async () => {
    const created = await container
      .get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate)
      .execute(validInput);

    await container.get<DeleteTemplate>(TEMPLATE_TYPES.DeleteTemplate).execute(created.id);

    await expect(
      container.get<DeleteTemplate>(TEMPLATE_TYPES.DeleteTemplate).execute(created.id),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('lists with a limit+1 sentinel for cursor pagination', async () => {
    const create = container.get<CreateTemplate>(TEMPLATE_TYPES.CreateTemplate);
    for (let i = 0; i < 3; i++) {
      await create.execute({ ...validInput, name: `Digest ${i}` });
    }

    const rows = await container
      .get<ListTemplates>(TEMPLATE_TYPES.ListTemplates)
      .execute({ limit: 2 });

    // limit + 1 fetched so the caller can detect a next page.
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
