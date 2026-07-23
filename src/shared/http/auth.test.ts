import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/index.js';
import { DefaultClock, type Clock } from '../clock/index.js';
import { JoseAccessTokenService } from '../auth/index.js';
import { TEST_ENV } from '../testing/index.js';
import { jwtAuth, requireRole } from './auth.js';
import { onError } from './on-error.js';
import type { AppEnv } from './app-env.js';

class StubClock implements Clock {
  constructor(private readonly fixed: Date) {}
  now(): Date {
    return this.fixed;
  }
}

const config = loadConfig(TEST_ENV);
const tokens = new JoseAccessTokenService(config, new DefaultClock());

function buildApp() {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  // `jwtAuth` sets the auth context the protected handler echoes back.
  app.use('/protected/*', jwtAuth(tokens));
  app.get('/protected/whoami', (c) => {
    const auth = c.get('auth');
    return c.json({ userId: auth?.userId, role: auth?.role });
  });
  // Admin-only branch: verify then role-guard.
  app.use('/admin/*', jwtAuth(tokens), requireRole('admin'));
  app.get('/admin/thing', (c) => c.json({ ok: true }));
  return app;
}

async function bearer(claims: { userId: string; role: string }) {
  return { authorization: `Bearer ${await tokens.issueAccessToken(claims)}` };
}

describe('jwtAuth middleware', () => {
  const app = buildApp();

  it('401s when the Authorization header is missing', async () => {
    const res = await app.request('/protected/whoami');
    expect(res.status).toBe(401);
  });

  it('401s on a non-bearer scheme', async () => {
    const res = await app.request('/protected/whoami', { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
  });

  it('401s on a malformed / mis-signed token', async () => {
    const res = await app.request('/protected/whoami', {
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('401s on an expired token', async () => {
    const past = new JoseAccessTokenService(config, new StubClock(new Date('2000-01-01T00:00:00Z')));
    const token = await past.issueAccessToken({ userId: 'u1', role: 'admin' });
    const res = await app.request('/protected/whoami', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('passes a valid token and exposes { userId, role }', async () => {
    const res = await app.request('/protected/whoami', { headers: await bearer({ userId: 'u42', role: 'manager' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'u42', role: 'manager' });
  });
});

describe('requireRole guard', () => {
  const app = buildApp();

  it('allows the matching role (admin → 200)', async () => {
    const res = await app.request('/admin/thing', { headers: await bearer({ userId: 'a', role: 'admin' }) });
    expect(res.status).toBe(200);
  });

  it('403s a present-but-wrong role (manager)', async () => {
    const res = await app.request('/admin/thing', { headers: await bearer({ userId: 'm', role: 'manager' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('401s when unauthenticated (no token reaches the guard)', async () => {
    const res = await app.request('/admin/thing');
    expect(res.status).toBe(401);
  });
});
