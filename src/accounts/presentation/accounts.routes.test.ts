import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from 'inversify';
import { buildContainer } from '../../shared/di/index.js';
import { TEST_ENV, bearerHeaders } from '../../shared/testing/index.js';
import { createApp } from '../../app.js';
import {
  ACCOUNTS_TYPES,
  InMemoryUserRepository,
  InMemoryRefreshTokenRepository,
  FakePasswordHasher,
} from '../index.js';

const json = { 'content-type': 'application/json' };

function build() {
  const container: Container = buildContainer(TEST_ENV);
  container.rebind(ACCOUNTS_TYPES.UserRepository).to(InMemoryUserRepository);
  container.rebind(ACCOUNTS_TYPES.RefreshTokenRepository).to(InMemoryRefreshTokenRepository);
  container.rebind(ACCOUNTS_TYPES.PasswordHasher).to(FakePasswordHasher);
  return createApp(container);
}

describe('accounts routes', () => {
  let app: ReturnType<typeof build>;
  let admin: Record<string, string>;
  let manager: Record<string, string>;

  beforeEach(async () => {
    app = build();
    admin = await bearerHeaders({ userId: 'admin-1', role: 'admin' });
    manager = await bearerHeaders({ userId: 'mgr-1', role: 'manager' });
  });

  function post(path: string, headers: Record<string, string>, body: unknown) {
    return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  async function setup(email = 'boss@dispatch.example', password = 'hunter2!!') {
    return post('/v1/setup', json, { email, password });
  }

  describe('setup (open, one-time)', () => {
    it('creates the first user as admin (201), no password hash leaked', async () => {
      const res = await setup();
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.role).toBe('admin');
      expect(body.email).toBe('boss@dispatch.example');
      expect(body).not.toHaveProperty('passwordHash');
      expect(body).not.toHaveProperty('password');
    });

    it('409s once a user exists', async () => {
      await setup();
      const res = await setup('other@dispatch.example');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('conflict');
    });

    it('rejects a too-short password (400 validation_error)', async () => {
      const res = await setup('boss@dispatch.example', 'short');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error');
    });
  });

  describe('login / refresh / logout (open)', () => {
    beforeEach(async () => {
      await setup();
    });

    it('logs in and returns a Bearer session', async () => {
      const res = await post('/v1/auth/login', json, {
        email: 'boss@dispatch.example',
        password: 'hunter2!!',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tokenType: string; accessToken: string; refreshToken: string };
      expect(body.tokenType).toBe('Bearer');
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
    });

    it('rejects wrong credentials (401)', async () => {
      const res = await post('/v1/auth/login', json, {
        email: 'boss@dispatch.example',
        password: 'wrong',
      });
      expect(res.status).toBe(401);
    });

    it('refreshes a session and logs out', async () => {
      const login = (await (
        await post('/v1/auth/login', json, { email: 'boss@dispatch.example', password: 'hunter2!!' })
      ).json()) as { refreshToken: string };

      const refreshed = await post('/v1/auth/refresh', json, { refreshToken: login.refreshToken });
      expect(refreshed.status).toBe(200);
      const next = (await refreshed.json()) as { refreshToken: string };

      const out = await post('/v1/auth/logout', json, { refreshToken: next.refreshToken });
      expect(out.status).toBe(204);

      // The revoked token no longer refreshes.
      const replay = await post('/v1/auth/refresh', json, { refreshToken: next.refreshToken });
      expect(replay.status).toBe(401);
    });
  });

  describe('user management (admin only)', () => {
    it('rejects unauthenticated access (401)', async () => {
      const res = await app.request('/v1/users');
      expect(res.status).toBe(401);
    });

    it('lets an admin create and list users', async () => {
      const created = await post('/v1/users', { ...admin, ...json }, {
        email: 'ed@dispatch.example',
        password: 'editor-pw!',
        role: 'manager',
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as Record<string, unknown>;
      expect(body.role).toBe('manager');
      expect(body).not.toHaveProperty('passwordHash');

      const list = await app.request('/v1/users', { headers: admin });
      expect(list.status).toBe(200);
      const page = (await list.json()) as { data: unknown[]; meta: { nextCursor: string | null } };
      expect(page.data).toHaveLength(1);
    });

    it('409s on a duplicate email', async () => {
      const body = { email: 'ed@dispatch.example', password: 'editor-pw!', role: 'manager' };
      await post('/v1/users', { ...admin, ...json }, body);
      const dup = await post('/v1/users', { ...admin, ...json }, body);
      expect(dup.status).toBe(409);
    });

    it('forbids a manager from creating users (403)', async () => {
      const res = await post('/v1/users', { ...manager, ...json }, {
        email: 'x@dispatch.example',
        password: 'x-pw-1234',
        role: 'manager',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    });

    it('forbids a manager from listing users (403)', async () => {
      const res = await app.request('/v1/users', { headers: manager });
      expect(res.status).toBe(403);
    });
  });

  it('serves the accounts paths + auth tag in the OpenAPI document', async () => {
    const doc = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, unknown>;
    };
    expect(doc.paths).toHaveProperty('/v1/setup');
    expect(doc.paths).toHaveProperty('/v1/auth/login');
    expect(doc.paths).toHaveProperty('/v1/users');
    expect(doc.paths).toHaveProperty('/v1/users/{id}');
  });
});
