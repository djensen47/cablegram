// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { User } from '../domain/user.js';
import { MongoUserRepository } from './mongo-user-repository.js';

const now = new Date('2026-01-01T00:00:00Z');

describe('MongoUserRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoUserRepository;

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoUserRepository(db);
  });

  afterEach(async () => {
    await db.collection('users').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  it('creates, finds by id + normalized email, and counts', async () => {
    await repo.create(
      User.create({ id: 'u1', email: 'Boss@Dispatch.Example', passwordHash: 'h', role: 'admin', now }),
    );

    expect((await repo.findById('u1'))?.email).toBe('boss@dispatch.example');
    expect((await repo.findByEmail('boss@dispatch.example'))?.id).toBe('u1');
    expect(await repo.findByEmail('missing@dispatch.example')).toBeNull();
    expect(await repo.countAll()).toBe(1);
  });

  it('lists id-ordered with exclusive-cursor pagination', async () => {
    for (const id of ['c', 'a', 'b']) {
      await repo.create(
        User.create({ id, email: `${id}@dispatch.example`, passwordHash: 'h', role: 'manager', now }),
      );
    }
    const first = await repo.list({ limit: 2 });
    expect(first.map((u) => u.id)).toEqual(['a', 'b']);
    const second = await repo.list({ limit: 2, cursor: 'b' });
    expect(second.map((u) => u.id)).toEqual(['c']);
  });

  it('rejects a duplicate email via the unique index', async () => {
    await repo.create(
      User.create({ id: 'u1', email: 'dup@dispatch.example', passwordHash: 'h', role: 'admin', now }),
    );
    // A different id but the same email must be refused by the unique index.
    await expect(
      repo.create(
        User.create({ id: 'u2', email: 'dup@dispatch.example', passwordHash: 'h', role: 'manager', now }),
      ),
    ).rejects.toThrow();
  });

  it('updates a stored user (e.g. a new password hash)', async () => {
    const user = User.create({ id: 'u1', email: 'boss@dispatch.example', passwordHash: 'old', role: 'admin', now });
    await repo.create(user);
    user.changePassword('new-hash', new Date('2026-02-01T00:00:00Z'));
    await repo.update(user);
    expect((await repo.findById('u1'))?.passwordHash).toBe('new-hash');
  });
});
