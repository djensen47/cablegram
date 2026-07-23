import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import {
  NEWSLETTER_TYPES,
  InMemoryNewsletterRepository,
  CreateNewsletter,
  GetNewsletter,
  ListNewsletters,
  UpdateNewsletter,
  DeleteNewsletter,
  InvalidEmailAddressError,
  NewsletterNotFoundError,
} from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_FROM_ADDRESS: 'system@cablegram.example',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// Rebind the repository token to the in-memory double (ADR-003); the rest of
// the container (use cases, clock) is the real wiring.
function testContainer(): Container {
  const container = buildContainer(env);
  container.rebind(NEWSLETTER_TYPES.NewsletterRepository).to(InMemoryNewsletterRepository);
  return container;
}

const validInput = {
  name: 'The Weekly Dispatch',
  fromName: 'Dispatch Editors',
  fromEmail: 'Editors@Dispatch.Example',
  replyTo: 'replies@dispatch.example',
  sendingDomain: 'mail.dispatch.example',
  dkimIdentifier: 'pm',
};

describe('newsletters use cases', () => {
  let container: Container;

  beforeEach(() => {
    container = testContainer();
  });

  it('creates a newsletter, normalizing the sender email', async () => {
    const created = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute(validInput);

    expect(created.id).toBeTruthy();
    expect(created.fromEmail.value).toBe('editors@dispatch.example');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.createdAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it('rejects an invalid sender email', async () => {
    await expect(
      container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute({ ...validInput, fromEmail: 'not-an-email' }),
    ).rejects.toBeInstanceOf(InvalidEmailAddressError);
  });

  it('gets a newsletter by id', async () => {
    const created = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute(validInput);

    const fetched = await container
      .get<GetNewsletter>(NEWSLETTER_TYPES.GetNewsletter)
      .execute(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe(validInput.name);
  });

  it('throws NewsletterNotFoundError for a missing id', async () => {
    await expect(
      container.get<GetNewsletter>(NEWSLETTER_TYPES.GetNewsletter).execute('missing'),
    ).rejects.toBeInstanceOf(NewsletterNotFoundError);
  });

  it('updates a newsletter and bumps updatedAt', async () => {
    const created = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute(validInput);

    const updated = await container
      .get<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter)
      .execute(created.id, { name: 'Renamed Dispatch', replyTo: null });

    expect(updated.name).toBe('Renamed Dispatch');
    expect(updated.replyTo).toBeNull();
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());
  });

  it('deletes a newsletter, then reports it missing', async () => {
    const created = await container
      .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
      .execute(validInput);

    await container.get<DeleteNewsletter>(NEWSLETTER_TYPES.DeleteNewsletter).execute(created.id);

    await expect(
      container.get<DeleteNewsletter>(NEWSLETTER_TYPES.DeleteNewsletter).execute(created.id),
    ).rejects.toBeInstanceOf(NewsletterNotFoundError);
  });

  it('lists with a limit+1 sentinel for cursor pagination', async () => {
    const create = container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter);
    for (let i = 0; i < 3; i++) {
      await create.execute({ ...validInput, name: `Newsletter ${i}` });
    }

    const rows = await container
      .get<ListNewsletters>(NEWSLETTER_TYPES.ListNewsletters)
      .execute({ limit: 2 });

    // limit + 1 fetched so the caller can detect a next page.
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
