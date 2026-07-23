// Repository contract test (docs/testing.md) — see the newsletters contract
// test's header comment for the full rationale; same posture here.
import { MongoClient, type Db } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { StoredRefreshToken } from '../application/refresh-token-repository.js';
import { MongoRefreshTokenRepository } from './mongo-refresh-token-repository.js';

function token(overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken {
  return {
    tokenHash: 'hash-1',
    userId: 'u1',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('MongoRefreshTokenRepository (contract)', () => {
  let client: MongoClient;
  let db: Db;
  let repo: MongoRefreshTokenRepository;

  beforeAll(async () => {
    client = new MongoClient(inject('mongoUri'));
    await client.connect();
    db = client.db();
    repo = new MongoRefreshTokenRepository(db);
  });

  afterEach(async () => {
    await db.collection('refresh_tokens').deleteMany({});
  });

  afterAll(async () => {
    await client.close();
  });

  it('creates and finds a token by its hash', async () => {
    await repo.create(token());
    const found = await repo.findByHash('hash-1');
    expect(found?.userId).toBe('u1');
    expect(found?.expiresAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(await repo.findByHash('nope')).toBeNull();
  });

  it('deletes by hash, returning true once and false thereafter', async () => {
    await repo.create(token());
    expect(await repo.deleteByHash('hash-1')).toBe(true);
    expect(await repo.deleteByHash('hash-1')).toBe(false);
    expect(await repo.findByHash('hash-1')).toBeNull();
  });
});
