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
  InvalidNewsletterError,
  NewsletterNotFoundError,
  Newsletter,
  EmailAddress,
} from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  BASE_URL: 'https://cablegram.test',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  SYSTEM_EMAIL_CHANNEL: 'outbound',
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
  campaignChannel: 'weekly-dispatch',
  confirmationChannel: 'weekly-confirmations',
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

  describe('opt-in mode (ADR-032)', () => {
    it('defaults a new newsletter to single opt-in', async () => {
      const created = await container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute(validInput);
      expect(created.doubleOptIn).toBe(false);
    });

    it('creates with double opt-in, and switches it on update', async () => {
      const created = await container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute({ ...validInput, doubleOptIn: true });
      expect(created.doubleOptIn).toBe(true);

      const updated = await container
        .get<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter)
        .execute(created.id, { doubleOptIn: false });
      expect(updated.doubleOptIn).toBe(false);
    });
  });

  describe('campaign and confirmation channels (ADR-030, ADR-031)', () => {
    it('stores both channels given at creation, trimmed', async () => {
      const created = await container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute({
          ...validInput,
          campaignChannel: '  weekly-dispatch  ',
          confirmationChannel: ' weekly-confirmations ',
        });
      expect(created.campaignChannel).toBe('weekly-dispatch');
      expect(created.confirmationChannel).toBe('weekly-confirmations');
    });

    it('refuses an empty or whitespace-containing channel, naming the field', async () => {
      const create = container.get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter);
      await expect(create.execute({ ...validInput, campaignChannel: '   ' })).rejects.toThrow(
        /campaignChannel/,
      );
      await expect(
        create.execute({ ...validInput, confirmationChannel: 'weekly confirmations' }),
      ).rejects.toThrow(/confirmationChannel/);
      await expect(create.execute({ ...validInput, campaignChannel: '' })).rejects.toBeInstanceOf(
        InvalidNewsletterError,
      );
    });

    it('sets both channels on a newsletter stored before they existed', async () => {
      // A pre-ADR-030 row: it loads normally with no channels, and an update
      // writes them onto it — no migration.
      const repository = container.get<InMemoryNewsletterRepository>(
        NEWSLETTER_TYPES.NewsletterRepository,
      );
      const now = new Date('2026-01-01T00:00:00Z');
      await repository.create(
        Newsletter.reconstitute({
          id: 'legacy-1',
          name: 'Legacy',
          fromName: 'Editors',
          fromEmail: EmailAddress.create('editors@dispatch.example'),
          replyTo: null,
          sendingDomain: null,
          dkimIdentifier: null,
          campaignChannel: null,
          confirmationChannel: null,
          doubleOptIn: false,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const before = await container.get<GetNewsletter>(NEWSLETTER_TYPES.GetNewsletter).execute('legacy-1');
      expect(before.campaignChannel).toBeNull();
      expect(before.confirmationChannel).toBeNull();

      const after = await container
        .get<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter)
        .execute('legacy-1', { campaignChannel: 'legacy-stream', confirmationChannel: 'legacy-confirm' });
      expect(after.campaignChannel).toBe('legacy-stream');
      expect(after.confirmationChannel).toBe('legacy-confirm');
      expect(after.name).toBe('Legacy');
    });

    it('leaves both channels alone when an update does not mention them', async () => {
      const created = await container
        .get<CreateNewsletter>(NEWSLETTER_TYPES.CreateNewsletter)
        .execute(validInput);
      const updated = await container
        .get<UpdateNewsletter>(NEWSLETTER_TYPES.UpdateNewsletter)
        .execute(created.id, { name: 'Renamed' });
      expect(updated.campaignChannel).toBe('weekly-dispatch');
      expect(updated.confirmationChannel).toBe('weekly-confirmations');
    });
  });
});
