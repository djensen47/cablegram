import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from './app-env.js';
import { idempotencyKey } from './idempotency.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import { onError } from './on-error.js';

describe('idempotencyKey', () => {
  let store: InMemoryIdempotencyStore;
  let calls: number;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    calls = 0;
    app = new Hono<AppEnv>();
    app.onError(onError);
    app.use('*', idempotencyKey(store));
    app.post('/things', async (c) => {
      calls += 1;
      const body = await c.req.json<{ name: string }>();
      return c.json({ id: calls, name: body.name }, 201);
    });
    app.get('/things', (c) => c.json({ calls }, 200));
  });

  it('passes through unchanged without the header (executes every time)', async () => {
    const req = () =>
      app.request('/things', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a' }),
      });
    await req();
    await req();
    expect(calls).toBe(2);
  });

  it('replays the cached response for a repeated key instead of re-executing', async () => {
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'k1' };
    const first = await app.request('/things', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'a' }),
    });
    const second = await app.request('/things', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'a' }),
    });

    expect(calls).toBe(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());
  });

  it('rejects a reused key with a different request body (409)', async () => {
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'k1' };
    await app.request('/things', { method: 'POST', headers, body: JSON.stringify({ name: 'a' }) });
    const res = await app.request('/things', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'b' }),
    });

    expect(res.status).toBe(409);
    expect(calls).toBe(1);
  });

  it('is scoped per key: a different key executes independently', async () => {
    const base = { 'content-type': 'application/json' };
    await app.request('/things', {
      method: 'POST',
      headers: { ...base, 'idempotency-key': 'k1' },
      body: JSON.stringify({ name: 'a' }),
    });
    await app.request('/things', {
      method: 'POST',
      headers: { ...base, 'idempotency-key': 'k2' },
      body: JSON.stringify({ name: 'a' }),
    });

    expect(calls).toBe(2);
  });

  it('never touches GET requests, even with the header present', async () => {
    const res = await app.request('/things', { headers: { 'idempotency-key': 'k1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: 0 });
  });
});
