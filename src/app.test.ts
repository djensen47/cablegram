import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildContainer } from './shared/di/index.js';
import { TEST_ENV, bearerHeaders } from './shared/testing/index.js';
import { createApp } from './app.js';

describe('app', () => {
  const app = createApp(buildContainer(TEST_ENV));

  it('serves an open health check', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'cablegram' });
  });

  it('rejects /v1 without a JWT', async () => {
    const res = await app.request('/v1/anything');
    expect(res.status).toBe(401);
  });

  it('passes /v1 auth with a valid token (then 404, no route)', async () => {
    const res = await app.request('/v1/anything', { headers: await bearerHeaders() });
    expect(res.status).toBe(404);
  });

  it('leaves the setup + auth endpoints open (no token needed to reach them)', async () => {
    // An invalid body reaches edge validation (400) rather than being turned
    // away 401 — proof the route is open, without touching the database.
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('validation_error');
  });

  it('advertises the Bearer JWT security scheme (not an API key)', async () => {
    const res = await app.request('/openapi.json');
    const doc = (await res.json()) as {
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.components?.securitySchemes).toHaveProperty('BearerAuth');
    expect(doc.components?.securitySchemes).not.toHaveProperty('ApiKeyAuth');
  });
});

describe('the /v1 gate under a host mount prefix', () => {
  // `OPEN_V1_PATHS` is an exact-match set of cablegram's OWN paths, but a host
  // that mounts the app (ADR-027) makes `c.req.path` its own full path
  // (`/newsletter/v1/auth/login`). Matching that raw path closed every open
  // route — nobody could log in, and one-click unsubscribe 401'd. Both
  // directions are pinned here: open stays open, gated stays gated.
  const host = new Hono();
  host.route('/newsletter', createApp(buildContainer(TEST_ENV)));

  it('still requires a JWT on a gated route', async () => {
    const res = await host.request('/newsletter/v1/newsletters');
    expect(res.status).toBe(401);
  });

  it('leaves login reachable (400 from edge validation, not 401)', async () => {
    const res = await host.request('/newsletter/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('leaves the public one-click unsubscribe reachable', async () => {
    // A forged token is a 400 (non-revealing, ADR-015) — so the route was
    // reached rather than turned away by the JWT gate.
    const res = await host.request(
      '/newsletter/v1/unsubscribe?newsletterId=n&subscriptionId=s&token=forged',
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
  });
});
