import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import {
  DELIVERABILITY_TYPES,
  InMemorySuppressionRepository,
  AddSuppression,
  RemoveSuppression,
  ListSuppressions,
  CheckSuppression,
  FilterSuppressed,
  InvalidSuppressedAddressError,
  SuppressionNotFoundError,
} from '../index.js';

const env = {
  DATABASE_URL: 'mongodb://localhost/cablegram',
  JWT_SECRET: 'a-sufficiently-long-jwt-signing-secret-value',
  POSTMARK_SERVER_TOKEN: 't',
  POSTMARK_WEBHOOK_SECRET: 's',
} as NodeJS.ProcessEnv;

// Rebind the repository token to the in-memory double (ADR-003); the rest of
// the container (use cases, clock) is the real wiring.
function testContainer(): Container {
  const container = buildContainer(env);
  container.rebind(DELIVERABILITY_TYPES.SuppressionRepository).to(InMemorySuppressionRepository);
  return container;
}

describe('deliverability use cases', () => {
  let container: Container;

  beforeEach(() => {
    container = testContainer();
  });

  it('adds a suppression entry, normalizing the address', async () => {
    const entry = await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'Bounced@Dispatch.Example', reason: 'hard-bounce' });

    expect(entry.address).toBe('bounced@dispatch.example');
    expect(entry.reason).toBe('hard-bounce');
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('rejects an invalid address', async () => {
    await expect(
      container
        .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
        .execute({ address: 'not-an-email', reason: 'hard-bounce' }),
    ).rejects.toBeInstanceOf(InvalidSuppressedAddressError);
  });

  it('is idempotent: re-adding an already-suppressed address keeps the original entry', async () => {
    const add = container.get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression);

    const first = await add.execute({ address: 'spam@dispatch.example', reason: 'hard-bounce' });
    const second = await add.execute({
      address: 'SPAM@dispatch.example',
      reason: 'spam-complaint',
    });

    expect(second.reason).toBe('hard-bounce');
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it('checks a suppressed address and reports non-suppressed as null', async () => {
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'junk@dispatch.example', reason: 'manual-junk' });

    const check = container.get<CheckSuppression>(DELIVERABILITY_TYPES.CheckSuppression);

    expect(await check.execute('junk@dispatch.example')).not.toBeNull();
    expect(await check.execute('clean@dispatch.example')).toBeNull();
  });

  it('removes a suppression entry, then reports it missing', async () => {
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'opt-out@dispatch.example', reason: 'global-opt-out' });

    const remove = container.get<RemoveSuppression>(DELIVERABILITY_TYPES.RemoveSuppression);
    await remove.execute('opt-out@dispatch.example');

    await expect(remove.execute('opt-out@dispatch.example')).rejects.toBeInstanceOf(
      SuppressionNotFoundError,
    );
  });

  it('lists with a limit+1 sentinel for cursor pagination', async () => {
    const add = container.get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression);
    for (let i = 0; i < 3; i++) {
      await add.execute({ address: `addr${i}@dispatch.example`, reason: 'hard-bounce' });
    }

    const rows = await container
      .get<ListSuppressions>(DELIVERABILITY_TYPES.ListSuppressions)
      .execute({ limit: 2 });

    // limit + 1 fetched so the caller can detect a next page.
    expect(rows).toHaveLength(3);
    const addresses = rows.map((r) => r.address);
    expect([...addresses].sort()).toEqual(addresses);
  });

  it('filterSuppressed returns only the suppressed subset of a batch', async () => {
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'bad1@dispatch.example', reason: 'hard-bounce' });
    await container
      .get<AddSuppression>(DELIVERABILITY_TYPES.AddSuppression)
      .execute({ address: 'bad2@dispatch.example', reason: 'spam-complaint' });

    const result = await container
      .get<FilterSuppressed>(DELIVERABILITY_TYPES.FilterSuppressed)
      .execute(['bad1@dispatch.example', 'good@dispatch.example', 'BAD2@dispatch.example']);

    expect(result.sort()).toEqual(['bad1@dispatch.example', 'bad2@dispatch.example']);
  });
});
